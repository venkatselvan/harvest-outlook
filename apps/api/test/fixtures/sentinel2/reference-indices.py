"""Independent pure-Python reference for the Sentinel-2 index statistics in apps/api/src/providers/sentinel2.ts.
Written separately from the TypeScript (no numpy; no shared code). Offset 1000, SCL 4-7, raw B04 and B08 > 0,
corrected n + r > 200 DN; per index every corrected band > 0 DN, normalised differences skip a corrected sum <= 200 DN
and clamp to [-1, 1], EVI skips a denominator below 0.1 and clamps to [-2, 2]. Percentiles interpolate linearly (NumPy default).
Usage: python3 -I reference-indices.py <nine-band.npy> [<four-band.npy>]"""
import ast, struct, sys

def load(path):
    b = open(path, 'rb').read()
    assert b[:6] == b'\x93NUMPY'
    major = b[6]
    if major == 1:
        hl = struct.unpack('<H', b[8:10])[0]; hs = 10
    else:
        hl = struct.unpack('<I', b[8:12])[0]; hs = 12
    hdr = ast.literal_eval(b[hs:hs + hl].decode('latin1'))
    assert hdr['descr'] == '<u2' and not hdr['fortran_order']
    shape = hdr['shape']; n = 1
    for s in shape: n *= s
    data = struct.unpack('<%dH' % n, b[hs + hl:])
    k, h, w = shape; px = h * w
    return shape, [list(data[i * px:(i + 1) * px]) for i in range(k)]

def pct(s, p):
    n = len(s)
    if not n: return None
    idx = p * (n - 1); lo = int(idx // 1); hi = lo if idx == lo else lo + 1
    return s[lo] + (s[hi] - s[lo]) * (idx - lo)

def r4(x): return None if x is None else round(x, 4)

def summary(v):
    v = sorted(v)
    if not v: return None
    return dict(n=len(v), mean=r4(sum(v) / len(v)), median=r4(pct(v, .5)), p10=r4(pct(v, .1)), p90=r4(pct(v, .9)))

shape, bands = load(sys.argv[1])
print('shape', shape)
B02, B03, B04, B05, B08, B8A, B11, SCL, MASK = bands
off = 1000
if len(sys.argv) > 2:
    s4, f4 = load(sys.argv[2])
    print('4-band shape', s4, 'B04 equal', f4[0] == B04, 'B08 equal', f4[1] == B08, 'SCL equal', f4[2] == SCL, 'mask equal', f4[3] == MASK)
c = lambda d: max(d - off, 0)
dens = []
out = {k: [] for k in ['ndvi', 'evi', 'ndre', 'gndvi', 'savi', 'ndmi', 'lswi', 'ndwi']}
for i in range(len(MASK)):
    if not MASK[i] or SCL[i] not in (4, 5, 6, 7) or B04[i] <= 0 or B08[i] <= 0: continue
    r, n = c(B04[i]), c(B08[i])
    if r + n <= 200: continue
    out['ndvi'].append(max(-1, min(1, (n - r) / (n + r))))
    def nd(a, b, rawa, rawb, key):
        A, B = c(rawa), c(rawb)
        if A <= 0 or B <= 0 or A + B <= 200: return
        out[key].append(max(-1, min(1, (A - B) / (A + B))))
    nd(B08[i], B05[i], B08[i], B05[i], 'ndre')
    nd(B08[i], B03[i], B08[i], B03[i], 'gndvi')
    nd(B08[i], B11[i], B08[i], B11[i], 'ndmi')
    nd(B8A[i], B11[i], B8A[i], B11[i], 'lswi')
    nd(B03[i], B08[i], B03[i], B08[i], 'ndwi')
    rn, rr = n / 10000, r / 10000
    if n > 0 and r > 0:
        out['savi'].append(max(-1.5, min(1.5, 1.5 * (rn - rr) / (rn + rr + 0.5))))
    if n > 0 and r > 0 and c(B02[i]) > 0:
        rb = c(B02[i]) / 10000
        den = rn + 6 * rr - 7.5 * rb + 1
        dens.append(den)
        if den >= 0.1: out['evi'].append(max(-2, min(2, 2.5 * (rn - rr) / den)))
for k, v in out.items(): print(k, summary(v))
print('EVI denominator min', round(min(dens), 4) if dens else None, 'max', round(max(dens), 4) if dens else None)
for name, band in (('B05', B05), ('B8A', B8A), ('B11', B11), ('B04', B04)):
    print(name, 'distinct values', len(set(band)), 'of', len(band))
