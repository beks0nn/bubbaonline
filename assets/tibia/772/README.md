# Tibia 7.72 graphics

`Tibia.dat` and `Tibia.spr` were copied unchanged from the supplied OTCv8 client's
`data/things/772` directory. These are the only files needed from that client.

Keep both files here for `npm run build:cast` and the standalone cast development
server. The build copies them into the generated `public/cast-client/assets/`
directory. The original `otclientv8-master` directory is no longer required.
