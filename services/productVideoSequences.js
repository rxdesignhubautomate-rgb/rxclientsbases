import { config } from "../config.js";

const FINAL_VISUAL_AID_MESSAGE = [
  "Sir, agar aapko Visual Aid ke liye koi bhi requirement hoti hai to RX Design Hub team se connect kar sakte hain.",
  "",
  "Call:",
  "tel:+919129172980",
  "",
  "WhatsApp:",
  "https://wa.me/919219548031",
  "",
  "Address:",
  "Sector 3, Vikas Nagar",
  "",
  "Location:",
  "https://maps.app.goo.gl/TgKTAJbb5VwT9ein6",
  "",
  "Shubham Kumar",
  "RX Design Hub"
].join("\n");

const VISUAL_AID_VIDEO_CAPTIONS = [
  "Sir, ye Visual Aid ka premium sample video check kar lijiye.\n\nIsse design quality ka clear idea mil jayega.",
  "Sir, is video me Visual Aid ki printing finish aur paper quality ka sample hai.\n\nAap quality check kar lijiye.",
  "Sir, ye latest Visual Aid design aur finishing sample hai.\n\nAise premium look me brand presentation strong lagti hai.",
  "Sir, ye final Visual Aid sample image share kar raha hoon.\n\nAgar quality suitable lage to quantity bata dijiye, team quotation guide kar degi."
];

export function defaultVisualAidVideoCaptions() {
  return [...VISUAL_AID_VIDEO_CAPTIONS];
}

export function detectSequenceProduct({ text = "", requirement = "" } = {}) {
  const combined = `${text} ${requirement}`.toLowerCase();

  if (
    /\bvisual\b/.test(combined)
    || combined.includes("visual aid")
    || combined.includes("visualaid")
    || combined.includes("aid book")
    || combined.includes("visual book")
  ) {
    return "visual_aid";
  }

  return "";
}

export function getProductSequence(product, videos = config.visualAidSequenceVideos, captions = []) {
  if (product !== "visual_aid") return null;

  const videoSteps = videos.slice(0, 4).map((media, index) => ({
    delayHours: [4, 8, 14, 20][index],
    type: index === 3 ? "image" : "video",
    media,
    caption: String(captions[index] || "").trim()
      || VISUAL_AID_VIDEO_CAPTIONS[index]
      || VISUAL_AID_VIDEO_CAPTIONS[0]
  }));

  return {
    product: "visual_aid",
    name: "Visual Aid Engagement",
    steps: [
      ...videoSteps,
      {
        delayHours: 22,
        type: "text",
        text: FINAL_VISUAL_AID_MESSAGE
      }
    ]
  };
}

export function getSequenceStep(product, stepIndex) {
  const sequence = getProductSequence(product);
  if (!sequence) return null;
  return sequence.steps[Number(stepIndex) || 0] || null;
}

export function getNextSequenceStep(product, currentStepIndex) {
  const sequence = getProductSequence(product);
  if (!sequence) return null;
  return sequence.steps[(Number(currentStepIndex) || 0) + 1] || null;
}

export function addHours(dateValue, hours) {
  return new Date(new Date(dateValue).getTime() + Number(hours || 0) * 60 * 60 * 1000).toISOString();
}
