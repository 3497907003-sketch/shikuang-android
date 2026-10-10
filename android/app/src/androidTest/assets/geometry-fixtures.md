The EXIF fixtures are derived from the existing quartz.jpg smoke photo, resized
to 512x320 and saved with EXIF orientation 6. quartz-exif6-upright.png is the
Pillow EXIF-transposed decoded JPEG. They test photo orientation and ROI geometry
inside the actual packaged WebView, never enter model training, and provide no
new claim that the specimen identity has been independently verified.

The orientation check permits a maximum RGB decoder difference of 4 at the full
decoded size. All three real-photo crops must use the exact center-square source
rectangle. Their JPEG-versus-upright-PNG resize differences are reported rather
than assumed to share a desktop rasterizer's numeric tolerance. A separately
generated coordinate pattern checks bilinear crop boundaries within 2 RGB units;
it is an algorithm fixture, never a mineral or training image. Neither source
format resize parity nor Pillow-versus-Canvas pixel parity is asserted. Separate
browser/Pillow measurement lives in the web tests/helpers preprocessing script.
