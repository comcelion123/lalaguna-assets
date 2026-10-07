lalaguna-assets - every file lalaguna.studio reads from this repo
=================================================================
Served by jsDelivr at
  https://cdn.jsdelivr.net/gh/comcelion123/lalaguna-assets@main/<path>
A NEW filename is live the moment it is pushed. A CHANGED file under the
same name is cached for about 12 hours - so when something is re-rendered,
it gets a new name (-v2, -v3) and the code is pointed at it.

Neoda-v3.typeface.js                 the wordmark face as a three.js typeface,
                                     for the glass CEDAIN (footer script tag)
lalaguna-studio__CEDAIN-intro-module-v4.js
lalaguna-studio__CEDAIN-intro-module-v4.min.js
                                     the glass gate on the land; the footer
                                     loads the .min (v3 was the film version)
land/                                the CEDAIN gate's landscape (desktop)
  terrain-near-1024.png              heights over the mountains and the core,
                                     12 km at 11.7 m/px, 16-bit as R*256+G
  terrain-far-1024.png               the 48 km box at 47 m/px
  terrain-ring-512.png               the 100 km ring for the horizon
  city-lights-v1.bin                 lamps, street segments, window glow
  land-manifest.json                 the frame, the encoding, the boxes
city/                                the walkable Bogota (home page, desktop)
  city-manifest.json                 index of the tiles (the city block carries
                                     a copy inline; this one is for reference)
  ground-atlas-v2.png                street level for the whole core, 16-bit
  ground-roads.webp                  the streets as a texture on the ground
  tiles/city_XX_YY.glb               buildings, Draco, 9 tiles (the land gate
                                     reads these too, for its core)
  tiles/road_XX_YY.glb               street ribbons (fallback only)
  tiles/green_XX_YY.glb              parks (fallback only)
  tiles/city_XX_YY.occ.png           where you cannot walk
env/                                 surroundings
  cedain-city-1080.mp4               the CEDAIN gate's surround on phones:
  cedain-city-720.mp4                the end of the flight over the city at
  cedain-city-poster.jpg             night, looped (phones get the 720)
  pano_dusk.jpg                      TO COME from UE5 (ue_pano_capture.py):
  pano_dusk_sky.png                  the mountain view behind About / Studio
intro/                               the opening film (home page)
  bogota-intro-1080.av1.mp4          desktop, AV1
  bogota-intro-720.h264.mp4          desktop, H.264 (Safari and older)
  bogota-intro-540.av1.mp4           phone, AV1
  bogota-intro-480.h264.mp4          phone, H.264
  bogota-intro-poster.jpg            first frame
earth/                               the Studio globe
  earth-day-4096.jpg                 Blue Marble (NASA, public domain)
  earth-night-4096.jpg               Black Marble (NASA, public domain)
  earth-water-2048.jpg               the ocean mask

Credits carried on the site: terrain Copernicus DEM GLO-30 (ESA); buildings
UAECD Bogota cadastre; roads (c) OpenStreetMap contributors, ODbL.

Not used by lalaguna.studio any more (safe to delete if nothing else reads
them): lalaguna-studio__CEDAIN-intro-module.js (the first gate),
lalaguna-studio__CEDAIN-intro-module-v3.js / .min.js (the film gate),
lukang-akon-bg-v2.mp4, lukang-akon-bg-v2-mobile.mp4.
