import { getDb } from "../firebase.js";
import { nowIso } from "../utils/time.js";
import { defaultVisualAidVideoCaptions } from "./productVideoSequences.js";

const SETTINGS = "settings";
const SEQUENCE_VIDEOS_DOC = "sequenceVideos";
const VISUAL_AID_KEY = "visual_aid";

export async function getVisualAidSequenceVideos(fallbackVideos = []) {
  const config = await getVisualAidSequenceConfig(fallbackVideos);
  return config.videos;
}

export async function getVisualAidSequenceConfig(fallbackVideos = []) {
  const db = getDb();
  const snap = await db.collection(SETTINGS).doc(SEQUENCE_VIDEOS_DOC).get();
  const data = snap.exists ? snap.data() : {};
  const visualAid = data[VISUAL_AID_KEY] || {};
  const defaultCaptions = defaultVisualAidVideoCaptions();

  return {
    videos: [1, 2, 3, 4]
      .map((slot, index) => String(visualAid[`video${slot}`] || fallbackVideos[index] || "").trim())
      .filter(Boolean),
    captions: [1, 2, 3, 4].map((slot, index) => (
      String(visualAid[`caption${slot}`] || defaultCaptions[index] || "").trim()
    ))
  };
}

export async function getSequenceVideoSettings() {
  const db = getDb();
  const snap = await db.collection(SETTINGS).doc(SEQUENCE_VIDEOS_DOC).get();
  const data = snap.exists ? snap.data() : {};
  const visualAid = data[VISUAL_AID_KEY] || {};
  const defaults = defaultVisualAidVideoCaptions();

  return {
    visualAid: {
      video1: String(visualAid.video1 || "").trim(),
      video2: String(visualAid.video2 || "").trim(),
      video3: String(visualAid.video3 || "").trim(),
      video4: String(visualAid.video4 || "").trim(),
      caption1: String(visualAid.caption1 || defaults[0] || "").trim(),
      caption2: String(visualAid.caption2 || defaults[1] || "").trim(),
      caption3: String(visualAid.caption3 || defaults[2] || "").trim(),
      caption4: String(visualAid.caption4 || defaults[3] || "").trim(),
      updatedAt: visualAid.updatedAt || null
    }
  };
}

export async function saveVisualAidSequenceVideo(slot, mediaId) {
  const videoSlot = Number(slot);
  if (![1, 2, 3, 4].includes(videoSlot)) {
    throw new Error("Valid sequence video slot is required");
  }

  const cleanMediaId = String(mediaId || "").trim();
  if (!cleanMediaId) {
    throw new Error("Media id is required");
  }

  const db = getDb();
  await db.collection(SETTINGS).doc(SEQUENCE_VIDEOS_DOC).set(
    {
      [VISUAL_AID_KEY]: {
        [`video${videoSlot}`]: cleanMediaId,
        updatedAt: nowIso()
      }
    },
    { merge: true }
  );

  return getSequenceVideoSettings();
}

export async function saveVisualAidSequenceCaptions(captions = {}) {
  const patch = {};
  for (const slot of [1, 2, 3, 4]) {
    const value = captions[`caption${slot}`] ?? captions[`video${slot}Caption`] ?? "";
    patch[`caption${slot}`] = String(value || "").trim().slice(0, 900);
  }

  const db = getDb();
  await db.collection(SETTINGS).doc(SEQUENCE_VIDEOS_DOC).set(
    {
      [VISUAL_AID_KEY]: {
        ...patch,
        updatedAt: nowIso()
      }
    },
    { merge: true }
  );

  return getSequenceVideoSettings();
}
