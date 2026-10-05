"""Install a hash-pinned public model; never download while collecting pages."""
import hashlib
from pathlib import Path
import shutil
import urllib.request
from captcha_vision import MODEL_SHA256, MODEL_URL, model_path


def install():
    target = model_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(Path(__file__).with_name('YOLOX-LICENSE.txt'), target.parent / 'YOLOX-LICENSE.txt')
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == MODEL_SHA256:
        print('CAPTCHA_MODEL_READY')
        return
    temporary = target.with_suffix('.download')
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=90) as source, temporary.open('wb') as output:
            size = 0
            while chunk := source.read(1024 * 1024):
                size += len(chunk)
                if size > 40_000_000:
                    raise ValueError('MODEL_TOO_LARGE')
                output.write(chunk)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != MODEL_SHA256:
            raise ValueError('MODEL_HASH_MISMATCH')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print('CAPTCHA_MODEL_READY')


if __name__ == '__main__':
    install()
