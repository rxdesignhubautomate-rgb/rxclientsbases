import { companyKnowledge, products } from "./knowledgeBase.js";
import { detectBuyingSignal } from "./leadScoring.js";

const PRODUCT_LIST = "Visual Aid, Reminder Card, Chit Pad, Chemist Book, Prescription Pad aur E-Visual App";

export function buildLocalLeadReply({ lead = {}, customerMessage = "" } = {}) {
  const text = String(customerMessage || "").trim();
  const product = findProduct(text) || findProduct(lead.requirement || "");
  const intent = detectIntent(text);
  const hasQuantity = hasQuantitySignal(text);
  const handoffRequired = intent.price || intent.sample || intent.call || intent.urgent || hasQuantity || detectBuyingSignal(text);
  const temperature = handoffRequired ? "hot" : product ? "warm" : "cold";
  const reply = formatReply(selectReply({ text, product, intent, hasQuantity }));

  return {
    reply,
    temperature,
    summary: buildSummary({ text, product, intent }),
    fields: {
      name: null,
      city: null,
      budget: null,
      urgency: intent.urgent ? "urgent" : null,
      requirement: product?.name || cleanRequirement(lead.requirement)
    },
    handoff_required: handoffRequired,
    next_action: nextActionFor({ product, intent, hasQuantity })
  };
}

function selectReply({ text, product, intent, hasQuantity }) {
  if (!text || intent.greeting) {
    return `Welcome to RX Design Hub, Sir!

Hum pharma ${PRODUCT_LIST} me design + printing service provide karte hain.

Sir, aapko kaunsa product chahiye?`;
  }

  if (intent.sample) {
    if (product?.sampleLink) {
      return `Bilkul Sir, ye ${product.name} sample link check kar lijiye:

${product.sampleLink}

Isme latest designs mil jayenge.`;
    }

    return `Bilkul Sir, sample share ho jayega.

Aap bata dijiye kaunse product ka sample chahiye: ${PRODUCT_LIST}?`;
  }

  if (intent.price) {
    return product?.objections?.price
      || "Ok Sir, aap please product type aur quantity share kar dijiye, team jaldi hi quotation ke liye connect karegi.";
  }

  if (intent.moq) {
    return product?.objections?.moq
      || (product ? `Sir, ${product.name} ka ${product.moq} ${firstQuestion(product)}` : "Sir, aap product name bata dijiye, MOQ detail share kar dunga.");
  }

  if (intent.call) {
    return "Ji Sir, team aapse jaldi connect karegi.\n\nAap product aur quantity share kar dijiye, main sales representative ko assign kar deta hun.";
  }

  if (intent.urgent) {
    return "Ji Sir, urgent basis par sales representative assign karta hun.\n\nAap product aur quantity share kar dijiye.";
  }

  if (intent.location) {
    return `Sir, hamara office Lucknow me hai aur PAN India service available hai.

Location: ${companyKnowledge.mapsLink}`;
  }

  if (intent.delivery) {
    return "Ji Sir, PAN India courier/transport ho jaega.\n\nTimeline product, quantity aur approval ke according team confirm karegi.";
  }

  if (intent.payment) {
    return "Sir, payment terms, GST/invoice aur advance details order requirement ke according team confirm karegi.\n\nAap product aur quantity share kar dijiye.";
  }

  if (intent.design) {
    return "Ji Sir, hame bas Brand Name aur Composition chahiye.\n\nBaaki design, content aur premium pharma layout hamari team handle kar deti hai.";
  }

  if (intent.printing) {
    return "Ji Sir, agar design ready hai to sirf printing bhi ho jaegi.\n\nAap product, quantity aur design file type share kar dijiye.";
  }

  if (product) {
    return product.answerStyle || `Sir, ${product.name} ke liye ${firstQuestion(product)}`;
  }

  if (hasQuantity) {
    return "Sir, quantity noted.\n\nAap product type bata dijiye, team best option aur quotation guide kar degi.";
  }

  return `Sir, aapka message mil gaya.

Aap ${PRODUCT_LIST} me se product type aur quantity share kar dijiye.`;
}

function detectIntent(text = "") {
  const normalized = text.toLowerCase();

  return {
    greeting: /^(?:hi+|hello+|hey+|hlo|hy|namaste|namaskar|good\s*(?:morning|evening|afternoon)|ji|sir|hello sir|hi sir)[\s.!?]*$/i.test(text),
    price: matches(normalized, ["price", "rate", "cost", "quotation", "quote", "charges", "kitna", "kitne", "daam", "amount", "keemat"]),
    sample: matches(normalized, ["sample", "catalog", "catalogue", "portfolio", "photo", "photos", "image", "video", "design sample"]),
    moq: matches(normalized, ["moq", "minimum order", "minimum qty", "minimum quantity", "minimum kitna"]),
    call: matches(normalized, ["call", "phone", "baat", "contact", "callback", "call karo", "phone karo"]),
    urgent: matches(normalized, ["urgent", "jaldi", "immediate", "today", "asap", "fast", "turant", "aaj hi", "abhi"]),
    location: matches(normalized, ["location", "address", "map", "office", "lucknow", "pata"]),
    delivery: matches(normalized, ["delivery", "dispatch", "courier", "transport", "ship", "shipping", "pan india"]),
    payment: matches(normalized, ["payment", "advance", "upi", "gst", "invoice", "bill"]),
    design: matches(normalized, ["design bhi", "design karte", "sirf design", "only design", "design only", "brand name", "composition"]),
    printing: matches(normalized, ["printing only", "sirf printing", "design ready", "print only", "editable file", "open file"])
  };
}

function findProduct(text = "") {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;

  let bestMatch = null;

  for (const product of products) {
    for (const alias of product.aliases) {
      if (!containsAlias(normalized, alias)) continue;

      const score = String(alias || "").length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { product, score };
      }
    }
  }

  return bestMatch?.product || null;
}

function containsAlias(text, alias) {
  const normalizedAlias = String(alias || "").toLowerCase().trim();
  if (!normalizedAlias) return false;

  if (normalizedAlias.length <= 3 && !normalizedAlias.includes(" ")) {
    return new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`, "i").test(text);
  }

  return text.includes(normalizedAlias);
}

function hasQuantitySignal(text = "") {
  return /\b\d{1,6}\s*(?:pcs|pieces?|piece|qty|quantity|pad|pads|book|books|card|cards|copies|copy|nos|unit|units)\b/i.test(text);
}

function matches(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function firstQuestion(product) {
  return product?.qualificationQuestions?.[0] || "Aap quantity share kar dijiye.";
}

function buildSummary({ text, product, intent }) {
  const flags = Object.entries(intent)
    .filter(([, matched]) => matched)
    .map(([name]) => name);
  const parts = [
    "Local fallback reply used because AI response was unavailable or disabled.",
    product ? `Matched product: ${product.name}.` : "Product not clear yet.",
    flags.length ? `Intent: ${flags.join(", ")}.` : "Intent not specific.",
    text ? `Customer message: ${text}` : "Customer message was blank."
  ];

  return parts.join(" ").slice(0, 700);
}

function nextActionFor({ product, intent, hasQuantity }) {
  if (intent.sample) return "share_sample_and_follow_up";
  if (intent.price || hasQuantity) return "sales_team_should_confirm_quotation";
  if (intent.call || intent.urgent) return "sales_team_should_call_customer";
  if (product) return "collect_next_requirement_detail";
  return "ask_product_type";
}

function cleanRequirement(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, 300) : null;
}

function formatReply(reply) {
  const normalized = String(reply || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    return "Sir, product type aur quantity share kar dijiye.\n\nRX Design Hub team best option guide kar degi.";
  }

  return normalized.slice(0, 620);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
