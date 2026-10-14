# Ghostty timing API check

Chrome 154.0.8037.93, Apple M1 hardware WebGPU. Five echo turns per engine and presentation mode. This checks the new API; it is not a replacement for the twenty-trial workload matrix.

| Mode | Engine | Input to first output | First to last output | Last output to drawn | Drawn to page update | Input to page update |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| frame | brush | 4.90 | 0.00 | 12.80 | 1.33 | 24.01 |
| frame | just-bash | 6.53 | 0.00 | 14.02 | 1.08 | 23.18 |
| frame | bashkit | 4.88 | 0.00 | 10.24 | 1.24 | 22.45 |
| frame | bashkit-terminal | 4.45 | 0.00 | 1.27 | 1.34 | 23.58 |
| immediate | brush | 8.57 | 0.00 | 12.17 | 1.28 | 24.38 |
| immediate | just-bash | 2.39 | 0.00 | 10.94 | 1.28 | 25.27 |
| immediate | bashkit | 6.07 | 0.00 | 10.21 | 1.37 | 22.27 |
| immediate | bashkit-terminal | 3.89 | 0.00 | 1.59 | 1.41 | 5.77 |

All values are milliseconds. Each column is a separate median, so their sum need not equal the median total. First output can include line-editor feedback; this API does not classify shell stdout separately. Worker phase spans remain available in the raw JSON. presentedAt ends at the first task after the page update, not physical display scanout. All forty events had input/output/drawn/presented timestamps in order, with hidden=false.
