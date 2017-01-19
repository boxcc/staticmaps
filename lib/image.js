var fs = require('fs');
var PNG = require('pngjs2').PNG;
var _ = require('lodash');

var Image = function (options) {

    options.colorType = 6;

    this.png = new PNG(options);
    this.width = this.png.width;
    this.height = this.png.height;

};

module.exports = Image;

Image.prototype.drawImage = function (tiles) {

  return new Promise (_.bind(function(resolve, reject) {
    var key = 0;

    _.each(tiles, _.bind(function (data) {

      var tile = new PNG({
        colorType: 6
      });

      tile.parse(data.body, _.bind(function(error){

        if (error) reject(error);

        var x = data.box[0];
        var y = data.box[1];

        var extraWidth = x + tile.width - this.width;
        var extraHeight = y + tile.width - this.height;

        var w = tile.width + (x < 0 ? x : 0) - (extraWidth > 0 ? extraWidth : 0);
        var h = tile.height + (y < 0 ? y : 0) - (extraHeight > 0 ? extraHeight : 0);

        var sx = x < 0 ? -x : 0;
        var sy = y < 0 ? -y : 0;

        var dx = x < 0 ? 0 : x;
        var dy = y < 0 ? 0 : y;

        tile.bitblt(this.png, sx, sy, w, h, dx, dy);

        if (key === tiles.length-1) resolve(true);
        key++;

      },this));
    },this));
  },this));

};

Image.prototype.pack = function () {
  return this.png.pack();
};

Image.prototype.save = function (fileName) {
  return this.png.pack().pipe(fs.createWriteStream(fileName));
};