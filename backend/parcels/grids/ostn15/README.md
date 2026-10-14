# OSTN15 NTv2 grid

`OSTN15_NTv2_OSGBtoETRS.gsb` is the Ordnance Survey OSTN15 NTv2 transformation grid, copied from the official [OSTN15 NTv2 archive](https://www.ordnancesurvey.co.uk/documents/resources/OSTN15-NTv2.zip). The four `OSTN15_Test*` files are the official OS control points distributed in that archive.

The OS guide supplies the grid and controls under the 3-Clause BSD licence. See [LICENSE](LICENSE). Required attribution:

> © Copyright and database rights Ordnance Survey Limited 2016. All rights reserved.

The grid is registered by `osgb36-projection.js` and is not a fallback approximation. The archive is 28 MB; this repository includes only the reverse-direction grid needed by proj4 and the official control files.

Grid SHA-256: `bcb9c6b3b2760e2740fd80e2182fd2eec4e79038165bac703a9415ed1813dee2`.
