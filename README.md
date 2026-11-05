# lalaguna-assets

Files that lalaguna.studio loads at runtime. The site reads these exact paths, so
don't rename or move anything without updating the site code too.

| Folder | What it is | Loaded through |
|---|---|---|
| `/` | `lalaguna-studio__CEDAIN-intro-module-v7.min.js`, `Neoda-v3.typeface.js` | jsDelivr |
| `intro/` | Opening film (AV1 1080/540, H.264 720/480), hold loop, poster, rainforest sound | jsDelivr |
| `env/` | CEDAIN city film for phones + poster | jsDelivr |
| `land/` | CEDAIN land: terrain plates and city lights | jsDelivr |
| `city/` | Homepage city: manifest, ground atlas, roads, facades, Draco tiles | raw GitHub |
| `earth/` | Studio globe day / night / water maps | raw GitHub |
| `studio/v2/<project>/` | Studio projects: `cover.jpg` + `01.jpg`, `02.jpg`… | raw GitHub |

jsDelivr: `https://cdn.jsdelivr.net/gh/comcelion123/lalaguna-assets@main/<path>`
(an updated file under the same name stays cached ~12 h, so give changed files a new name).
raw GitHub: `https://raw.githubusercontent.com/comcelion123/lalaguna-assets/main/<path>`.

Limits: 20 MB per file on jsDelivr. Studio images are JPEG, longest side 2400 px; covers 1280×800.
