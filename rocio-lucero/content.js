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
  tagline: "Cantante · Compositora",
  // Shown in Google results and when the link is shared
  description: "Official website of Rocío Lucero — music, videos, live dates and contact.",
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
    label: "Nuevo sencillo",
    title: "Título de la canción",
    link: "",               // link to the song (Spotify, YouTube, smart link…). Empty = button hidden.
    buttonText: "Escuchar ahora",
  },

  /* ---------- Social & streaming links ----------
     Paste the full address. Leave "" to hide an icon. */
  links: {
    spotify: "",
    appleMusic: "",
    youtube: "",
    instagram: "",
    tiktok: "",
    soundcloud: "",
    bandcamp: "",
    facebook: "",
  },

  /* ---------- Music ----------
     For each release: paste the Spotify link to the song/album
     (Spotify app → Share → Copy link). The player is created automatically. */
  music: [
    // {
    //   title: "Título",
    //   year: "2026",
    //   type: "Sencillo",           // Sencillo / EP / Álbum
    //   spotify: "https://open.spotify.com/track/....",
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
      "Rocío Lucero es cantante y compositora. Escribe aquí tu historia: de dónde vienes, qué te inspira y qué suena en tu música.",
      "Segundo párrafo: logros, colaboraciones, próximos proyectos.",
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
    email: "",              // e.g. "booking@rociolucero.com"
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
