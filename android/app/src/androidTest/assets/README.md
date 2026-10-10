# Runtime smoke fixtures

- `quartz.jpg`: the existing project's real quartz photo `data/raw/quartz/train_0027.jpg`, retained only as a regression fixture. Source labels from the existing dataset are not a new independent accuracy benchmark. Do not count this image toward field validation or Kappa.
- `dog.jpg`: the public PyTorch Hub example photograph from https://github.com/pytorch/hub/blob/master/images/dog.jpg, used to verify non-mineral rejection. It is not mineral training data.

The test preserves each photo's aspect ratio and reduces the longest side to at most 640 pixels before submitting it through the installed app's photo-file UI. These assets are packaged only in the instrumentation test APK, not the user app.
