The EXIF fixtures are derived from the existing quartz.jpg smoke photo, resized
to 512x320 and saved with EXIF orientation 6. quartz-exif6-upright.png is the
Pillow EXIF-transposed decoded JPEG. They test photo orientation and ROI geometry
inside the actual packaged WebView, never enter model training, and provide no
new claim that the specimen identity has been independently verified.

The geometry check permits a maximum RGB decoder difference of 4. This compares
the JPEG decoder with its upright PNG reference using the same Canvas resize;
it does not assert Pillow and Canvas resize pixels are identical. Separate
browser/Pillow measurement lives in the web tests/helpers preprocessing script.
