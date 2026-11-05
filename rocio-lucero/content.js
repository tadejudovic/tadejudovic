/* ==========================================================================
   ROCÍO LUCERO — WEBSITE CONTENT
   --------------------------------------------------------------------------
   This is the ONLY file you need to edit to change the website.

   Rules of thumb:
   • Change the text between the quotes "like this".
   • Keep the commas at the end of lines.
   • To hide a whole section, empty its list:  shows: [],
   • Leave a link as "" to hide its button/icon.
   • Photos go in the /images folder; refer to them as "images/my-photo.jpg".
   ========================================================================== */

window.SITE = {
  /* ---------- Basics ---------- */
  name: "Rocío Lucero",
  tagline: "Cantautora",
  // Shown in Google results and when the link is shared
  description: "Rocío Lucero, cantautora. Escucha Todos mis ex nada, su primer EP.",
  heroImage: "",            // e.g. "images/hero.jpg" (wide photo). Empty = soft color background.
  language: "es",           // "es" or "en" (used by browsers and screen readers)

  /* ---------- Look & feel ---------- */
  theme: {
    accent: "#e8a87c",      // buttons and highlights
    background: "#14100f",  // page background
    text: "#f4ece6",        // main text
  },

  /* ---------- Big button at the top (latest release) ---------- */
  featured: {
    label: "Primer EP · ya disponible",
    title: "Todos mis ex nada",
    link: "https://open.spotify.com/artist/3aCOUbBAkayyHXx3W3qPg4",  // tip: replace with the EP's own Spotify link
    buttonText: "Escuchar en Spotify",
  },

  /* ---------- Social & streaming links ----------
     Paste the full address. Leave "" to hide an icon. */
  links: {
    spotify: "https://open.spotify.com/artist/3aCOUbBAkayyHXx3W3qPg4",
    appleMusic: "",
    youtube: "",
    instagram: "https://www.instagram.com/rocioluceromusic/",
    tiktok: "",
    soundcloud: "",
    bandcamp: "",
    facebook: "",
  },

  /* ---------- Music ----------
     For each release: paste the Spotify link to the song/album
     (Spotify app → Share → Copy link). The player is created automatically.
     SoundCloud links work the same way: put them in  soundcloud: "..."  */
  music: [
    {
      // Spotify's artist player: shows her top songs, including the EP.
      // Tip: once you have the EP's own link (Spotify → the EP → Share → Copy link), paste it here instead.
      title: "Todos mis ex nada",
      year: "2026",
      type: "EP · 6 canciones",
      spotify: "https://open.spotify.com/artist/3aCOUbBAkayyHXx3W3qPg4",
      link: "",
    },
    {
      title: "Aquel verano",
      year: "2019",
      type: "Sencillo",
      spotify: "https://open.spotify.com/album/6p1EAvwJ0uVelQLLAkstjr",
      link: "",
    },
    // {
    //   title: "Título",
    //   year: "2026",
    //   type: "Sencillo",           // Sencillo / EP / Álbum
    //   spotify: "https://open.spotify.com/track/....",
    //   soundcloud: "",               // or a SoundCloud song link
    //   link: "",                    // optional extra link (smart link, Bandcamp…)
    // },
  ],

  /* ---------- Videos ----------
     Paste YouTube links (any format works). */
  videos: [
    // { title: "Videoclip oficial", youtube: "https://www.youtube.com/watch?v=...." },
  ],

  /* ---------- Shows / Concerts ----------
     Dates as "YYYY-MM-DD". Past dates disappear by themselves. */
  shows: [
    // {
    //   date: "2026-12-12",
    //   city: "Madrid",
    //   venue: "Sala Example",
    //   tickets: "https://...",       // leave "" if no tickets yet
    //   note: "",                     // e.g. "Agotado", "Entrada libre"
    // },
  ],
  showsEmptyText: "Nuevas fechas muy pronto.",  // shown when there are no upcoming shows

  /* ---------- About ----------
     One entry per paragraph. */
  about: {
    image: "",              // e.g. "images/portrait.jpg" (vertical photo works best)
    paragraphs: [
      // DRAFT written from what's public about her. Rocío: rewrite it in your own words.
      "Rocío Lucero es cantautora. Convierte sus historias, sus emociones y sus contradicciones en canciones.",
      "En abril de 2026 publicó Todos mis ex nada, su primer EP: seis canciones nacidas de todo lo que hemos vivido, perdido y aprendido en el amor.",
      "Lo presentó en directo el 8 de mayo de 2026 en la Sala Cultural El Desleal, en La Laguna (Tenerife), en un formato íntimo y cercano.",
    ],
  },

  /* ---------- Press kit (for promoters, journalists, venues) ---------- */
  press: {
    text: "Biografía, fotos en alta resolución y rider técnico.",
    downloadLink: "",       // link to a Google Drive / Dropbox folder. Empty = section hidden.
    buttonText: "Descargar press kit",
  },

  /* ---------- Contact ---------- */
  contact: {
    heading: "Contacto",
    text: "Booking, prensa y colaboraciones.",
    email: "booking@rociolucero.com",
    managementName: "",     // optional, e.g. "Management: Name"
    newsletterLink: "",     // optional link to a signup form (Mailchimp, Google Form, Laylo…)
    newsletterText: "Recibe novedades",
  },

  /* ---------- Menu labels (change the language here) ---------- */
  labels: {
    music: "Música",
    videos: "Videos",
    shows: "Conciertos",
    about: "Sobre mí",
    press: "Prensa",
    contact: "Contacto",
    tickets: "Entradas",
    listen: "Escuchar",
  },
};
