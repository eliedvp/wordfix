# Extrait la liste de fréquences française de wordfreq 3.1.1 (données CC BY-SA 4.0).
# Usage : python3 decode.py wordfreq-3.1.1-py3-none-any.whl > fr-raw.tsv
# Sortie : « mot<TAB>centibels » ; la fréquence du mot vaut 10^(-centibels / 100).
import gzip, io, sys, zipfile
import msgpack  # pip install msgpack

with zipfile.ZipFile(sys.argv[1]) as wheel:
    data = msgpack.unpackb(gzip.decompress(wheel.read('wordfreq/data/large_fr.msgpack.gz')), raw=False)
header, bins = data[0], data[1:]
assert header == {'format': 'cB', 'version': 1}, header
out = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', newline='\n')
for centibels, words in enumerate(bins):
    for word in words:
        out.write(f'{word}\t{centibels}\n')
