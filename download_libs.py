import urllib.request, os, ssl

lib_dir = os.path.join(os.path.dirname(__file__), 'lib')
os.makedirs(lib_dir, exist_ok=True)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

files = [
    ('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'leaflet.css'),
    ('https://unpkg.com/proj4@2.11.0/dist/proj4.js', 'proj4.js'),
    ('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'leaflet.js'),
    ('https://unpkg.com/@turf/turf@6/turf.min.js', 'turf.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', 'html2canvas.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'jspdf.umd.min.js'),
    ('https://unpkg.com/docx@8.5.0/build/index.umd.js', 'docx.umd.js'),
    ('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', 'xlsx.full.min.js'),
]

for url, name in files:
    dest = os.path.join(lib_dir, name)
    print(f'Downloading {name}...', flush=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        data = resp.read()
    with open(dest, 'wb') as f:
        f.write(data)
    print(f'  OK  {len(data):,} bytes -> {dest}', flush=True)

print('All done!')
