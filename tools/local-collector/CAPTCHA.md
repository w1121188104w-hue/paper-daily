# Local verification adapters

`verification.py` controls bounded retries and re-reads the publisher page after every action, including failed/timed-out actions. A solver return, an existing response field, or disappearance of the widget is not proof of collected content. `worker.py` applies the shared Node content assessor before recording `passed`; DeepSeek review remains downstream and unchanged.

Automatic checks and failed component loads get up to 30 seconds of observation; after an interaction the result gets up to 15 seconds. Each poll is 3 seconds apart and stops early on a phase change. Content loading has a separate cumulative 60-second allowance, shared across any reappearing gates; the verification deadline remains 150 seconds. A title or DOI alone is not content readiness. The document must finish loading, its main content must not explicitly be busy, and two consecutive content snapshots must agree. A timed-out catalog retains its cards for review but marks completeness unresolved; the worker also retains a loading-timeout task. This prevents a slow directory from being mistaken for an empty or complete directory.

`captcha_browser.py` operates only observed visible challenge controls in the collector's own browser. Image answers stay local. Normal diagnostic records contain enums, counts and exception classes/stack locations, without response tokens, input text, image URLs or URL query strings. Optional `PAPER_CAPTCHA_DEBUG_DIR` saves cropped challenge images and prompts for an isolated investigation; it is unset in normal operation.

Image inference uses the [OpenCV Zoo YOLOX_s model](https://github.com/opencv/opencv_zoo/tree/main/models/object_detection_yolox), exported with 80 COCO classes. Model: `object_detection_yolox_2022nov.onnx`, 35,858,002 bytes, SHA-256 `c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063`. License: [Apache 2.0](YOLOX-LICENSE.txt), copied from the model directory. Weights are not included in Git. `setup_models.py` downloads and verifies them before use. The default model directory is beside the Python virtual environment, or `PAPER_CAPTCHA_MODEL_DIR` when explicitly configured. ONNX Runtime loads verified bytes to support Windows paths containing Chinese characters.

Supported reCAPTCHA object names map explicitly to COCO classes. A 3×3 challenge classifies each independent tile; a 4×4 challenge maps detected objects across intersecting cells. A dynamic challenge is re-read after tile replacement before Verify is pressed. Unsupported labels are refreshed within the retry limit. hCaptcha image layouts and categories outside the installed model are not claimed as supported.

Text and slider inference uses [ddddocr](https://github.com/sml2h3/ddddocr), pinned to 1.6.1. That version returns slider match **centers**; transparent padding, half-width and CSS scaling must all be accounted for. The browser adapter supports readable Geetest/Yidun-style images/canvases, not arbitrary sliders or scrambled backgrounds. Text entry requires a single explicitly named CAPTCHA field and a dedicated form with no other visible fields. Unknown layouts are recorded without guessing.

Run regression tests in the collector environment:

```powershell
python -X utf8 -m unittest discover -s tools/local-collector -p 'test_*.py' -v
```

Tests cover stage transitions, recovery after exceptions, bounded retries, stale image rejection, dynamic grids, iframe connection routes, model hash verification, clipping/overlap and slider coordinate conversion. Live publisher tests are separate, bounded and do not submit test captures into the production library.
