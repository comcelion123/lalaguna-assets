lalaguna-assets-drop - every file lalaguna.studio reads from this repo
=====================================================================
Served by jsDelivr at
  https://cdn.jsdelivr.net/gh/comcelion123/lalaguna-assets@main/lalaguna-assets-drop/<path>
A NEW filename is live the moment it is pushed. A CHANGED file under the
same name is cached for about 12 hours - so when something is re-rendered,
it gets a new name (-v2, -v3) and the code is pointed at it.

Neoda-v3.typeface.js                 the wordmark face as a three.js typeface,
                                     for the glass CEDAIN (footer script tag)
lalaguna-studio__CEDAIN-intro-module-v3.js
lalaguna-studio__CEDAIN-intro-module-v3.min.js
                                     the glass gate; the footer loads the .min
city/                                the walkable Bogota (home page, desktop)
  city-manifest.json                 index of the tiles (the city block carries
                                     a copy inline; this one is for reference)
  ground-atlas-v2.png                street level for the whole core, 16-bit
  ground-roads.webp                  the streets as a texture on the ground
  tiles/city_XX_YY.glb               buildings, Draco, 9 tiles
  tiles/road_XX_YY.glb               street ribbons (fallback only)
  tiles/green_XX_YY.glb              parks (fallback only)
  tiles/city_XX_YY.occ.png           where you cannot walk
env/                                 surroundings
  cedain-city-1080.mp4               the CEDAIN gate's surround: the end of the
  cedain-city-720.mp4                flight over the city at night, looped
  cedain-city-poster.jpg             (phones get the 720)
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

Nothing outside this folder is needed any more.
