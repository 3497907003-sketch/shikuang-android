#!/usr/bin/env python3
"""Generate algorithm-only fixtures from existing photos; never training data.

Run prepare before tests/browser-preprocessing.cjs, then compare its raw output.
This measures geometry/EXIF and rasterizer differences, not mineral accuracy.
"""
import argparse
import base64
import io
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageOps


def png(image):
    buffer = io.BytesIO(); image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


def prepare(args):
    directory = Path(args.directory); directory.mkdir(parents=True, exist_ok=True)
    cases = []
    for name, path in [('quartz-existing-smoke-photo', args.quartz), ('dog-nonmineral', args.dog)]:
        with Image.open(path) as source:
            oriented = ImageOps.exif_transpose(source).convert('RGB')
        cases.append({'name': name, 'data': 'data:image/jpeg;base64,' + base64.b64encode(Path(path).read_bytes()).decode(),
                      'width': oriented.width, 'height': oriented.height, 'crops': [1, .75, .5]})
    # Non-square JPEG lets dimension and mirrored/rotated pixel checks detect ignored EXIF.
    with Image.open(args.quartz) as source:
        photo = ImageOps.exif_transpose(source).convert('RGB').resize((512,320), Image.Resampling.BILINEAR)
    for orientation in range(1,9):
        exif = Image.Exif(); exif[274] = orientation
        buffer = io.BytesIO(); photo.save(buffer, format='JPEG', quality=95, exif=exif)
        data = buffer.getvalue()
        with Image.open(io.BytesIO(data)) as source:
            expected = ImageOps.exif_transpose(source).convert('RGB')
        cases.append({'name': f'quartz-exif-{orientation}', 'data': 'data:image/jpeg;base64,' + base64.b64encode(data).decode(),
                      'reference': png(expected), 'width': expected.width, 'height': expected.height, 'crops': [1,.5], 'orientation': orientation})
        if orientation == 6:
            (directory/'quartz-exif6.jpg').write_bytes(data); expected.save(directory/'quartz-exif6-upright.png')
    # This coordinate pattern is an algorithm fixture, not a claimed mineral image.
    y,x = np.mgrid[:320,:512]
    coordinates = Image.fromarray(np.stack([x//2,y*255//319,np.full_like(x,91)],axis=-1).astype(np.uint8))
    cases.append({'name':'algorithm-coordinate-pattern','data':png(coordinates),'width':512,'height':320,'crops':[1,.75,.5],'algorithm_only':True})
    (directory/'inputs.json').write_text(json.dumps({'cases':cases,'scope':'Existing photos + EXIF variants; coordinate pattern only for geometry. No accuracy claim.'}))


def compare(args):
    directory=Path(args.directory)
    inputs=json.loads((directory/'inputs.json').read_text())
    browser=json.loads((directory/'browser-results.json').read_text())
    results=[]
    for case, observed in zip(inputs['cases'],browser['cases']):
        assert case['name']==observed['name'] and [case['width'],case['height']]==[observed['width'],observed['height']]
        with Image.open(io.BytesIO(base64.b64decode(case['data'].split(',',1)[1]))) as source:
            image=ImageOps.exif_transpose(source).convert('RGB')
        for actual in observed['crops']:
            crop=actual['crop']; side=min(image.size)*crop; left=(image.width-side)/2; top=(image.height-side)/2
            assert actual['geometry']==[left,top,side,side,0,0,224,224]
            reference=np.asarray(image.resize((224,224),Image.Resampling.BILINEAR,box=(left,top,left+side,top+side))).astype(np.int16)
            rgba=np.frombuffer(base64.b64decode(actual['pixels']),dtype=np.uint8).reshape(224,224,4)
            rgb=rgba[:,:,:3].astype(np.int16); difference=np.abs(rgb-reference)
            row={'name':case['name'],'crop':crop,'geometry':[left,top,side,side],
                 'rgb_abs_max':int(difference.max()),'rgb_abs_mean':float(difference.mean()),
                 'rgb_abs_p99':float(np.percentile(difference,99)),
                 'normalized_abs_max':float((difference/255/np.array([.229,.224,.225])).max())}
            if case.get('algorithm_only'):
                assert row['rgb_abs_max']<=2, 'Coordinate boundary differs from expected center-square bilinear mapping'
                row['coordinate_geometry_pass']=True
            results.append(row)
    report={'scope':inputs['scope'],'browser':browser['browser'],'pil_version':Image.__version__,
            'exif_orientations_tested':list(range(1,9)), 'geometry_consistent':True,
            'pixel_identical':all(row['rgb_abs_max']==0 for row in results),
            'limits':'EXIF decoder comparison threshold max RGB 4; coordinate geometry threshold max RGB 2. Real-photo PIL-vs-Canvas differences are measured, with no invented acceptance threshold or model parity claim.',
            'interpretation':'PIL bilinear downsizing and browser low-quality Canvas bilinear rasterization can use different filters, pixel rounding and JPEG decoders. Matching RGB normalization alone does not establish numerical inference parity or field accuracy.',
            'results':results,'browser_assertions':browser['assertions']}
    (directory/'preprocessing-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'geometry_consistent':True,'pixel_identical':report['pixel_identical'],'max_rgb_abs':max(r['rgb_abs_max'] for r in results),'report':str(directory/'preprocessing-report.json')}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('mode',choices=['prepare','compare']);parser.add_argument('--directory',required=True)
    parser.add_argument('--quartz');parser.add_argument('--dog');args=parser.parse_args()
    (prepare if args.mode=='prepare' else compare)(args)
