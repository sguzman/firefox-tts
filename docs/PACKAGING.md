# 📦 Firefox TTS package reproducibility

This repository builds an **unsigned** Firefox MV3 XPI using only Python's
standard library. No npm, pnpm, paid signing service, download or browser
profile access is required. The XPI is the same ZIP format that can later
be submitted for Mozilla signing, not a promise that Firefox release builds
can permanently install it unsigned.

```bash
python3 tools/build_xpi.py --output /tmp/firefox-tts-unsigned.xpi
```

The builder prints the output path, number of files and SHA-256 content hash.
Only `LICENSE`, `manifest.json` and `src/` HTML/CSS/JS ship. Native host
installers, voice models, tests, private configs, screenshots and CI metadata
never enter the XPI. Entry ordering, permissions and ZIP timestamps are fixed
for byte-identical output from the same checkout and Python/ZIP environment.

`tests/test_package.py` builds the same checkout twice in separate disposable
paths, asserts byte equality and SHA-256 equality, validates entries and rejects
unrelated files. GitHub Actions executes that test on every push.

**Release gate remains open:** an unsigned XPI isn't a signed Firefox release,
and the current code still needs Firefox/Piper integration QA. Do not replace
the existing Edge extension or any installed Firefox extension with it yet.
