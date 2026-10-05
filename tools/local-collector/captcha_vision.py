"""Local inference only. Browser interaction and proof of success stay outside."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

MODEL_NAME = 'object_detection_yolox_2022nov.onnx'
MODEL_SHA256 = 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063'
MODEL_URL = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/object_detection_yolox/' + MODEL_NAME
# COCO classes supported by the installed OpenCV Zoo model. Unsupported prompts
# never silently become another class (e.g. crosswalk is not traffic light).
LABELS = {
    1: (r'\bbicycles?\b', '自行车', '腳踏車', '脚踏车'),
    2: (r'\bcars?\b', '小汽车', '小汽車', '轿车', '轎車', '汽车', '汽車'),
    3: (r'\bmotorcycles?\b', '摩托车', '摩托車'),
    5: (r'\bbus(?:es)?\b', '公交车', '公交車', '公共汽车', '巴士'),
    6: (r'\btrains?\b', '火车', '火車'),
    7: (r'\btrucks?\b', '卡车', '卡車', '货车', '貨車'),
    9: (r'\btraffic lights?\b', '交通信号灯', '交通信號燈', '红绿灯', '紅綠燈'),
    10: (r'\bfire hydrants?\b', '消防栓', '消火栓'),
}


def prompt_class(prompt):
    # Longer/specific Chinese labels must win over generic 汽车.
    matches = [(len(pattern), label) for label, patterns in LABELS.items()
               for pattern in patterns if re.search(pattern, str(prompt).lower())]
    return max(matches)[1] if matches else None


def model_path():
    configured = os.environ.get('PAPER_CAPTCHA_MODEL_DIR')
    directory = Path(configured) if configured else Path(sys.prefix).parent / 'models'
    return directory / MODEL_NAME


def decode_image(encoded):
    import cv2
    import numpy as np
    if not isinstance(encoded, str) or len(encoded) > 6_000_000:
        raise ValueError('IMAGE_TOO_LARGE')
    data = base64.b64decode(encoded.split(',', 1)[-1], validate=True)
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.shape[0] > 4096 or image.shape[1] > 4096:
        raise ValueError('INVALID_IMAGE')
    return image


class Detector:
    def __init__(self, file=None):
        import cv2
        import numpy as np
        file = Path(file or model_path())
        if not file.is_file():
            raise FileNotFoundError('MODEL_NOT_INSTALLED')
        if hashlib.sha256(file.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError('MODEL_HASH_MISMATCH')
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.net = ort.InferenceSession(file.read_bytes(), sess_options=options, providers=['CPUExecutionProvider'])
        self.input_name = self.net.get_inputs()[0].name
        cv2.setNumThreads(2)
        self.grid, self.stride = [], []
        for stride in (8, 16, 32):
            y, x = np.mgrid[:640 // stride, :640 // stride]
            self.grid.extend(zip(x.ravel(), y.ravel()))
            self.stride.extend([stride] * x.size)
        self.grid = np.array(self.grid)
        self.stride = np.array(self.stride)[:, None]

    def boxes(self, image, label, threshold=0.45):
        import cv2
        import numpy as np
        h, w = image.shape[:2]
        if not h or not w:
            return []
        scale = min(640 / w, 640 / h)
        # YOLOX_s exported by OpenCV Zoo expects RGB pixels in [0,255].
        canvas = np.full((640, 640, 3), 114, dtype=np.uint8)
        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
        elif image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
        canvas[:int(h * scale), :int(w * scale)] = cv2.resize(image, (int(w * scale), int(h * scale)))
        blob = cv2.dnn.blobFromImage(canvas, swapRB=True)
        raw = self.net.run(None, {self.input_name: blob})[0][0]
        scores = raw[:, 4] * raw[:, 5 + label]
        selected = scores >= threshold
        centers = (raw[selected, :2] + self.grid[selected]) * self.stride[selected] / scale
        sizes = np.exp(raw[selected, 2:4]) * self.stride[selected] / scale
        boxes = np.concatenate((centers - sizes / 2, sizes), axis=1)
        scores = scores[selected]
        keep = cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), threshold, 0.45)
        return [{'x': float(boxes[i][0]), 'y': float(boxes[i][1]), 'w': float(boxes[i][2]),
                 'h': float(boxes[i][3]), 'confidence': float(scores[i])} for i in keep]


def box_hits_cell(box, cell):
    left, top = max(box['x'], cell['x']), max(box['y'], cell['y'])
    right = min(box['x'] + box['w'], cell['x'] + cell['w'])
    bottom = min(box['y'] + box['h'], cell['y'] + cell['h'])
    intersection = max(0, right - left) * max(0, bottom - top)
    # Exclude tiny edge overlap caused by a detector's loose bounding box.
    return intersection >= max(8, min(cell['w'] * cell['h'] * 0.025, box['w'] * box['h'] * 0.12))


def solve_grid(request, detector=None):
    label = prompt_class(request.get('prompt', ''))
    if label is None:
        return {'state': 'unsupported_prompt'}
    cells = request.get('cells', [])
    if len(cells) not in (9, 16):
        return {'state': 'unsupported_layout'}
    image = decode_image(request['image'])
    detector = detector or Detector()
    chosen = []
    if len(cells) == 16:
        boxes = detector.boxes(image, label)
        chosen = [i for i, cell in enumerate(cells) if any(box_hits_cell(b, cell) for b in boxes)]
    else:
        for i, cell in enumerate(cells):
            x, y, w, h = [int(cell[k]) for k in ('x', 'y', 'w', 'h')]
            tile = image[max(0, y):max(0, y + h), max(0, x):max(0, x + w)]
            if tile.size and detector.boxes(tile, label):
                chosen.append(i)
    return {'state': 'recognized', 'engine': 'opencv_yolox', 'label': label, 'indices': chosen}


def solve_text(request):
    import ddddocr
    image = decode_image(request['image'])
    import cv2
    value = ddddocr.DdddOcr(show_ad=False).classification(cv2.imencode('.png', image)[1].tobytes())
    if not re.fullmatch(r'[A-Za-z0-9]{3,10}', value):
        return {'state': 'uncertain_text'}
    return {'state': 'recognized', 'engine': 'ddddocr', 'value': value}


def solve_slider(request):
    import cv2
    import ddddocr
    foreground, background = decode_image(request['piece']), decode_image(request['background'])
    if foreground.ndim != 3 or foreground.shape[2] != 4:
        return {'state': 'unsupported_slider_image'}
    import numpy as np
    x0, y0, width, height = cv2.boundingRect((foreground[:, :, 3] > 32).astype(np.uint8))
    if width < 8 or height < 8 or width >= background.shape[1] or height > background.shape[0]:
        return {'state': 'unsupported_slider_image'}
    cropped = foreground[y0:y0 + height, x0:x0 + width]
    result = ddddocr.DdddOcr(ocr=False, det=False, show_ad=False).slide_match(
        cv2.imencode('.png', cropped)[1].tobytes(), cv2.imencode('.png', background)[1].tobytes())
    # Pinned ddddocr 1.6.1 returns the matching rectangle's CENTER, unlike old
    # releases. Account for both its half-width and transparent piece padding.
    if result.get('confidence', 0) < 0.45:
        return {'state': 'uncertain_slider'}
    x = result['target'][0] - width // 2 - x0
    if not 0 < x < background.shape[1]:
        return {'state': 'uncertain_slider'}
    return {'state': 'recognized', 'engine': 'ddddocr', 'x': x, 'image_width': background.shape[1]}


def main():
    import contextlib
    try:
        data = sys.stdin.read(8_000_001)
        if len(data) > 8_000_000:
            raise ValueError('REQUEST_TOO_LARGE')
        request = json.loads(data)
        with contextlib.redirect_stdout(sys.stderr):
            result = {'grid': solve_grid, 'text': solve_text, 'slider': solve_slider}[request['kind']](request)
    except FileNotFoundError:
        result = {'state': 'model_unavailable'}
    except ImportError:
        result = {'state': 'dependency_unavailable'}
    except Exception as error:
        result = {'state': 'inference_failed', 'error_type': type(error).__name__}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
