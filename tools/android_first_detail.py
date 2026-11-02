"""Read-only evidence gate for actual native first-result detail regression.

Host fixtures test this parser only. They are never native/device acceptance.
"""
from pathlib import Path
from urllib.parse import urlsplit


def need(condition, reason):
    if not condition:
        raise ValueError('first_detail_' + reason)


def verify_first_result_detail(report, manifest, manifest_sha256, reference, catalog,
                               sdk, page_size, folder):
    proof = report['firstResultDetail']
    need(proof['schema'] == 'android-first-result-detail-before-library-v1', 'schema')
    need(proof['initialLoaderStatus'] == 'idle' and proof['initialReferenceRequests'] == [], 'cold_reference_baseline')
    for key in ('initialIdentifyVisible', 'initialLibraryHidden', 'libraryStillHidden',
                'dialogOpen', 'loadingMessageAbsent', 'hasOfficialFields',
                'galleryPresent', 'galleryClosed', 'activityRecreateRestoredIdle'):
        need(proof[key] is True, key)
    need(type(proof['libraryClicks']) is int and proof['libraryClicks'] == 0, 'library_visited')
    before = proof['beforeClick']
    need(before['loaderStatus'] == 'idle' and type(before['referenceRequests']) is int
         and before['referenceRequests'] == 0 and before['libraryHidden'] is True
         and before['resultVisible'] is True, 'before_click')
    need(proof['loaderStatus'] == 'ready' and proof['title'] == '石英'
         and proof['online'] is False and proof['photoRequests'] == [], 'complete_offline_detail')
    analysis = proof['analysis']
    models = len(manifest['modes']['ensemble'])
    need(analysis['key'] == 'quartz' and analysis['engine'] == 'onnx-native-android', 'actual_native_inference')
    need(type(analysis['modelCount']) is int and analysis['modelCount'] == models
         and analysis['modelVersion'] == manifest['version']
         and analysis['manifestSha256'] == manifest_sha256, 'native_model_identity')
    diagnostic = analysis['diagnostics']
    need(type(diagnostic['elapsedMs']) is int and diagnostic['elapsedMs'] > 0
         and type(diagnostic['residentSessionCount']) is int
         and 0 < diagnostic['residentSessionCount'] <= models + 1, 'actual_native_diagnostics')
    for name in ('nativeNetworkBefore', 'nativeNetworkAfter'):
        native = proof[name]
        need(native['sdk'] == sdk and native['pageSize'] == page_size
             and native['packageName'] == 'com.shikuang.app.preview'
             and native['versionName'] == '2.5.0-preview.1' and native['versionCode'] == 25001,
             name + '_identity')
        need(native['activeNetwork'] is None and native['connected'] is False
             and native['internetCapability'] is False, name + '_offline')
    overlay = catalog['reviewed_book_evidence']
    expected_counts = {
        'totalBookStatements': len(overlay['records']), 'books': len(overlay['books']),
        'bookSourcePages': overlay['counts']['selected_source_pages'],
        'bookSpecies': len({row['catalog_id'] for row in overlay['records']}),
        'primarySpecies': reference['counts']['ima_species'],
        'sourceImageRecords': reference['counts']['source_image_records'],
    }
    need(expected_counts == {'totalBookStatements': 190, 'books': 11,
         'bookSourcePages': 23, 'bookSpecies': 63, 'primarySpecies': 6239,
         'sourceImageRecords': 871}, 'reviewed_public_catalog_profile')
    need(all(type(proof[k]) is int and proof[k] == v for k, v in expected_counts.items()), 'catalog_counts')
    expected_fields = sorted((row['field'], row['source_id'], row['pdf_page_1based'])
                             for row in overlay['records'] if row['catalog_id'] == 'ima-quartz')
    fields = proof['quartzBookFields']
    need(len(expected_fields) == 3 and proof['bookSections'] == 3 and len(fields) == 3, 'book_sections')
    need(all(row['renderedValueMatches'] is True for row in fields), 'rendered_book_values')
    need(sorted((row['field'], row['sourceId'], row['pdfPage']) for row in fields)
         == expected_fields, 'rendered_book_provenance')
    requests = proof['requests']
    paths = ['/data/reference-manifest.json'] + ['/' + row['path'] for row in reference['files']]
    need(len(requests) == 4 and [row['path'] for row in requests] == paths, 'exact_reference_requests')
    expected_origin = urlsplit(report['origin'])
    for row in requests:
        actual = urlsplit(row['url'])
        need(row['local'] is True and row['status'] == 200
             and row['startedPhase'] == 'first-detail-loading'
             and (actual.scheme, actual.netloc) == (expected_origin.scheme, expected_origin.netloc)
             and actual.path == row['path'] and 'error' not in row, 'packaged_reference_request')
    shot = proof['screenshot']
    need(shot['filename'] == 'quartz-first-result-detail.png' and shot['selector'] == '#detailTitle'
         and shot['text'] == '石英' and shot['visualStateSynchronized'] is True, 'screenshot_identity')
    for stage in ('Before', 'After'):
        native = shot['nativeWindow' + stage]
        need(native['passed'] is True and native['filename'] == shot['filename']
             and native['stage'] == stage.lower()
             and native['expectedPackage'] == 'com.shikuang.app.preview', 'screenshot_native_window')
    image = (Path(folder) / shot['filename']).read_bytes()
    need(image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) > 1024, 'screenshot_bytes')
    return {'firstResultDetailBeforeLibraryVerified': True, 'actualEngine': analysis['engine'],
            'bookStatements': proof['totalBookStatements'], 'quartzRenderedFields': len(fields),
            'referenceRequestsAfterDetailClick': len(requests), 'sdk': sdk, 'pageSize': page_size}
