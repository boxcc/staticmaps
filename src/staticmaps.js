import request from 'request-promise';
import gm from 'gm';
import Jimp from 'jimp';
import find from 'lodash.find';
import uniqBy from 'lodash.uniqby';
import chunk from 'lodash.chunk';

import Image from './image';
import IconMarker from './marker';
import Polyline from './polyline';

require('./helper/helper');

/* transform longitude to tile number */
const lonToX = (lon, zoom) => ((lon + 180) / 360) * (2 ** zoom);
/* transform latitude to tile number */
const latToY = (lat, zoom) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1
  / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (2 ** zoom);

const yToLat = (y, zoom) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (2 ** zoom))))
  / Math.PI * 180;

const xToLon = (x, zoom) => x / (2 ** zoom) * 360 - 180;

class StaticMaps {
  constructor(options = {}) {
    this.gm = gm;
    this.options = options;

    this.width = this.options.width;
    this.height = this.options.height;
    this.paddingX = this.options.paddingX || 0;
    this.paddingY = this.options.paddingY || 0;
    this.padding = [this.paddingX, this.paddingY];
    this.tileUrl = this.options.tileUrl || 'http://tile.openstreetmap.org/{z}/{x}/{y}.png';
    this.tileSize = this.options.tileSize || 256;
    this.tileRequestTimeout = this.options.tileRequestTimeout;
    this.tileRequestHeader = this.options.tileRequestHeader;
    this.reverseY = this.options.reverseY || false;

    // # features
    this.markers = [];
    this.lines = [];
    this.polygons = [];

    // # fields that get set when map is rendered
    this.center = [];
    this.centerX = 0;
    this.centerY = 0;
    this.zoom = 0;
    if (this.options.imageMagick && gm.subClass) {
      this.gm = this.gm.subClass({ imageMagick: true });
    }
  }

  addLine(options) {
    this.lines.push(new Polyline(options));
  }

  addMarker(options) {
    this.markers.push(new IconMarker(options));
  }

  addPolygon(options) {
    this.lines.push(new Polyline(options));
  }

  /**
    * Render static map with all map features that were added to map before
    */
  render(center, zoom) {
    if (!this.lines && !this.markers && !this.polygons && !(center && zoom)) {
      throw new Error('Cannot render empty map: Add  center || lines || markers || polygons.');
    }

    this.center = center;
    this.zoom = zoom || this.calculateZoom();

    if (center && center.length === 2) {
      this.centerX = lonToX(center[0], this.zoom);
      this.centerY = latToY(center[1], this.zoom);
    } else {
      // # get extent of all lines
      const extent = this.determineExtent(this.zoom);

      // # calculate center point of map
      const centerLon = (extent[0] + extent[2]) / 2;
      const centerLat = (extent[1] + extent[3]) / 2;

      this.centerX = lonToX(centerLon, this.zoom);
      this.centerY = latToY(centerLat, this.zoom);
    }

    this.image = new Image(this.options);

    return this.drawBaselayer()
      .then(this.drawFeatures.bind(this));
  }

  /**
    * calculate common extent of all current map features
    */
  determineExtent(zoom) {
    const extents = [];

    // Add bbox to extent
    if (this.center && this.center.length >= 4) extents.push(this.center);

    // Add polylines and polygons to extent
    if (this.lines.length) {
      this.lines.forEach((line) => {
        extents.push(line.extent());
      });
    } // extents.push(this.lines.map(function(line){ return line.extent(); }));

    // Add marker to extent
    for (let i = 0; i < this.markers.length; i++) {
      const marker = this.markers[i];
      const e = [marker.coord[0], marker.coord[1]];

      if (!zoom) {
        extents.push([
          marker.coord[0],
          marker.coord[1],
          marker.coord[0],
          marker.coord[1],
        ]);
        continue;
      }

      // # consider dimension of marker
      const ePx = marker.extentPx();
      const x = lonToX(e[0], zoom);
      const y = latToY(e[1], zoom);

      extents.push([
        xToLon(x - parseFloat(ePx[0]) / this.tileSize, zoom),
        yToLat(y + parseFloat(ePx[1]) / this.tileSize, zoom),
        xToLon(x + parseFloat(ePx[2]) / this.tileSize, zoom),
        yToLat(y - parseFloat(ePx[3]) / this.tileSize, zoom),
      ]);
    }

    // Add polygons to extent
    // if (this.polygons.length) extents.push(this.polygons.map(polygon => polygon.extent));

    return [
      extents.map(e => e[0]).min(),
      extents.map(e => e[1]).min(),
      extents.map(e => e[2]).max(),
      extents.map(e => e[3]).max(),
    ];
  }

  /**
    * calculate the best zoom level for given extent
    */
  calculateZoom() {
    for (let z = 17; z > 0; z--) {
      const extent = this.determineExtent(z);
      const width = (lonToX(extent[2], z) - lonToX(extent[0], z)) * this.tileSize;
      if (width > (this.width - (this.padding[0] * 2))) continue;

      const height = (latToY(extent[1], z) - latToY(extent[3], z)) * this.tileSize;
      if (height > (this.height - (this.padding[1] * 2))) continue;

      return z;
    }
    return null;
  }

  /**
    * transform tile number to pixel on image canvas
    */
  xToPx(x) {
    const px = ((x - this.centerX) * this.tileSize) + (this.width / 2);
    return Number(Math.round(px));
  }

  /**
    * transform tile number to pixel on image canvas
    */
  yToPx(y) {
    const px = ((y - this.centerY) * this.tileSize) + (this.height / 2);
    return Number(Math.round(px));
  }

  drawBaselayer() {
    const xMin = Math.floor(this.centerX - (0.5 * this.width / this.tileSize));
    const yMin = Math.floor(this.centerY - (0.5 * this.height / this.tileSize));
    const xMax = Math.ceil(this.centerX + (0.5 * this.width / this.tileSize));
    const yMax = Math.ceil(this.centerY + (0.5 * this.height / this.tileSize));

    const result = [];

    for (let x = xMin; x < xMax; x++) {
      for (let y = yMin; y < yMax; y++) {
        // # x and y may have crossed the date line
        const maxTile = (2 ** this.zoom);
        const tileX = (x + maxTile) % maxTile;
        let tileY = (y + maxTile) % maxTile;
        if (this.reverseY) tileY = ((1 << this.zoom) - tileY) - 1;

        result.push({
          url: this.tileUrl.replace('{z}', this.zoom).replace('{x}', tileX).replace('{y}', tileY),
          box: [
            this.xToPx(x),
            this.yToPx(y),
            this.xToPx(x + 1),
            this.yToPx(y + 1),
          ],
        });
      }
    }

    const tilePromises = [];

    result.forEach((r) => { tilePromises.push(this.getTile(r)); });

    return new Promise((resolve, reject) => {
      Promise.all(tilePromises)
        .then(tiles => this.image.draw(tiles))
        .then(resolve)
        .catch(reject);
    });
  }

  drawFeatures() {
    return this.drawLines()
      .then(this.loadMarker.bind(this))
      .then(this.drawMarker.bind(this));
  }


  drawLines() {
    return new Promise(async (resolve) => {
      if (!this.lines.length) resolve(true);

      // Due to gm limitations, we need to chunk coordinates
      const chunkedLines = [];
      this.lines.forEach((line) => {
        const lineChunks = chunk(line.coords, 119);
        lineChunks.forEach((lineChunk, i) => {
          const chunkedLine = { ...line };
          // Fixed #10
          if (lineChunks[i + 1] && lineChunks[i + 1][0]) lineChunk.push(lineChunks[i + 1][0]);
          chunkedLine.coords = lineChunk;
          chunkedLines.push(chunkedLine);
        });
      });
      // eslint-disable-next-line no-restricted-syntax
      for (const chunkedLine of chunkedLines) {
        await this.draw(chunkedLine); // eslint-disable-line no-await-in-loop
      }
      resolve(true);
    });
  }

  /**
   * Draw a polyline/polygon on a baseimage
   */
  async draw(line) {
    const { type } = line;
    const baseImage = this.image.image;

    return new Promise((resolve, reject) => {
      const points = line.coords.map(coord => [
        this.xToPx(lonToX(coord[0], this.zoom)),
        this.yToPx(latToY(coord[1], this.zoom)),
      ]);

      baseImage.getBuffer(Jimp.AUTO, (err, result) => {
        if (err) reject(err);
        if (type === 'polyline') {
          this.gm(result)
            .fill(0)
            .stroke(line.color, line.width)
            .drawPolyline(points)
            .toBuffer((errBuf, buffer) => {
              if (errBuf) reject(err);
              Jimp.read(buffer, (errRead, image) => {
                if (errRead) reject(err);
                this.image.image = image;
                resolve(image);
              });
            });
        } else if (type === 'polygon') {
          this.gm(result)
            .fill(line.fill)
            .stroke(line.color, line.width)
            .drawPolygon(points)
            .toBuffer((errBuf, buffer) => {
              if (errBuf) reject(err);
              Jimp.read(buffer, (errRead, image) => {
                if (errRead) reject(err);
                this.image.image = image;
                resolve(image);
              });
            });
        }
      });
    });
  }

  drawMarker() {
    const baseImage = this.image.image;

    return new Promise((resolve) => {
      this.markers.forEach((marker) => {
        baseImage.composite(marker.imgData, marker.position[0], marker.position[1]);
      });

      resolve(true);
    });
  }

  /**
    *   Preloading the icon image
    */
  loadMarker() {
    return new Promise((resolve, reject) => {
      if (!this.markers.length) resolve(true);

      const icons = uniqBy(this.markers.map(m => ({ file: m.img })), 'file');

      let count = 1;
      icons.forEach((ico) => {
        const icon = ico;
        Jimp.read(icon.file, (err, tile) => {
          if (err) reject(err);
          icon.data = tile;
          if (count++ === icons.length) {
            // Pre loaded all icons
            this.markers.forEach((mark) => {
              const marker = mark;
              marker.position = [
                this.xToPx(lonToX(marker.coord[0], this.zoom)) - marker.offset[0],
                this.yToPx(latToY(marker.coord[1], this.zoom)) - marker.offset[1],
              ];

              const imgData = find(icons, { file: marker.img });
              marker.set(imgData.data);
            });

            resolve(true);
          }
        });
      });
    });
  }

  /**
   *  Fetching tiles from endpoint
   */
  getTile(data) {
    return new Promise((resolve, reject) => {
      const options = {
        url: data.url,
        encoding: null,
        resolveWithFullResponse: true,
      };

      if (this.tileRequestTimeout) options.timeout = this.tileRequestTimeout;

      if (this.tileRequestHeader) options.headers = this.tileRequestHeader;

      request.get(options).then((res) => {
        resolve({
          url: data.url,
          box: data.box,
          body: res.body,
        });
      }).catch(reject);
    });
  }
}

export default StaticMaps;
module.exports = StaticMaps;
