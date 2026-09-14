// services/knowledgeBase.js

export const companyKnowledge = {
  businessName: "RX Design Hub",
  location: "Lucknow, India",
  mapsLink: "https://maps.app.goo.gl/1g3AkCQXgogu7mNG7",
  serviceArea: "PAN India",
  owner: "Shubham Kumar",
  shortIntro:
    "RX Design Hub pharma companies ke liye premium Visual Aid, Reminder Card, Chit Pad, Chemist Book, Prescription Pad aur E-Visual App ki complete design & printing service deta hai.",
  openingIntro:
    "Welcome to RX Design Hub, Sir! Hum pharma companies ke liye premium Visual Aid, Reminder Card, Chit Pad, Chemist Book, Prescription Pad aur E-Visual App ki complete design & printing service dete hain. Aapko sirf Brand Name aur Composition share karna hota hai, baaki MOA, Benefits, Clinical Content, Premium Designing, Printing, Binding aur App Setup hamari team handle karti hai. Sir, aapko kaunsa product chahiye?",
  positioning:
    "Customer ko sirf Brand Name aur Composition dena hota hai. MOA, benefits, clinical content, premium pharma layout, doctor-engaging design, printing, binding aur dispatch RX Design Hub team handle karti hai.",
  specialties: [
    "Only Brand Name and Composition required",
    "MOA, benefits and clinical-style content support",
    "Premium pharma promotional design",
    "In-house design, printing and binding support",
    "PAN India courier/transport support",
    "Fast service with low-cost premium quality",
    "E-Visual App / PPT App / Android tablet presentation support"
  ],
  process: [
    "Requirement collect karna",
    "Product, quantity, size/pages/finish confirm karna",
    "Quotation ke liye sales team connect karna",
    "Order/design stage par Brand Name aur Composition lena",
    "Content + design + approval",
    "Printing / binding / app setup",
    "Dispatch through courier/transport"
  ],
  delivery:
    "Ji Sir, PAN India courier/transport ho jaega. Dispatch timeline product, quantity aur approval speed ke according team confirm karegi.",
  payment:
    "Payment terms order type aur quantity ke according RX Design Hub team confirm karti hai.",
  pricingPolicy:
    "AI kabhi exact rate, price list, discount ya final quotation share nahi karega. Rate query par quantity/requirement collect karega aur bolega team jaldi connect karegi.",
  tone:
    "Hinglish, short WhatsApp style, professional, warm and energetic. Use Sir only. Reply in 2 short lines with blank line spacing. Avoid long paragraphs."
};

export const sampleLinks = {
  visualAid: "https://whatsapp.com/channel/0029Vb6tmie11ulRBYVDwx3K/111",
  reminderCard: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s",
  chitPad: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s",
  chemistBook: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s",
  prescriptionPad: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s",
  eVisualApp: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s",
  diary: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s",
  calendar: "https://whatsapp.com/channel/0029Vb81mBL96H4VGqKySz1s"
};

export const products = [
  {
    name: "Visual Aid",
    category: "Pharma Promotional Material",
    moq: "MOQ 5 books.",
    aliases: ["visual aid", "visual aids", "va", "va book", "visual book", "doctor book", "book visual"],
    sampleLink: sampleLinks.visualAid,
    shortDescription:
      "Premium pharma Visual Aid for doctor detailing with brand intro, composition, MOA, benefits, indications, clinical-style content and premium pharma layout.",
    specs: [
      "Sizes: 17x11 inch, 15x10 inch, small 12x9 inch, spiral 8.5x11 inch",
      "Normal page count: 5 to 35 pages; more pages par sales team confirm karegi",
      "Paper/GSM: 300 GSM, 250 GSM, NTR plastic sheet option",
      "Finish: Gloss, Matte, Velvet, UV",
      "Binding: Spiral, hard binding, center pin, book binding",
      "Pricing: printing charge + design charge = total charge; AI rate nahi batayega"
    ],
    keyFeatures: [
      "Only Brand Name and Composition required",
      "MOA, benefits and clinical content support",
      "Premium pharma layout",
      "Doctor-engaging design",
      "Printing and dispatch handled by team"
    ],
    qualificationQuestions: [
      "Sir, Visual Aid me kitne pages aur kitni quantity chahiye?"
    ],
    answerStyle:
      "Sir, Visual Aid ka MOQ 5 books hai. Isme 17x11, 15x10, 12x9 aur spiral 8.5x11 size options hain. Sir, Visual Aid me kitne pages aur kitni quantity chahiye?",
    objections: {
      price: "Ok Sir, aap please pages aur quantity share kar dijiye, team jaldi hi aapse connect karke quotation confirm karegi.",
      sample: `Sir, isme aap hamare latest Visual Aid samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge: ${sampleLinks.visualAid}`,
      moq: "Sir, Visual Aid ka MOQ 5 books hai. Aapko kitne pages aur kitni quantity chahiye?",
      design: "Ji Sir, hame bas Brand Name aur Composition chahiye, baaki MOA, benefits, clinical content aur premium design hamari team handle kar deti hai."
    }
  },
  {
    name: "Reminder Card",
    category: "Pharma Promotional Material",
    moq: "A5/A4 MOQ 1000 pcs. Pocket, 9.5x7 inch and dye-cut/different shape MOQ 2000 pcs each.",
    aliases: ["reminder card", "reminder cards", "doctor reminder", "rx card", "pocket reminder", "dye cut reminder", "die cut reminder"],
    sampleLink: sampleLinks.reminderCard,
    shortDescription:
      "Doctor desk par brand recall ke liye premium both-side reminder card.",
    specs: [
      "A5 size MOQ 1000 pcs",
      "A4 size MOQ 1000 pcs",
      "Pocket reminder MOQ 2000 pcs",
      "9.5 x 7 inch MOQ 2000 pcs",
      "Dye-cut / different shape MOQ 2000 pcs each",
      "Premium 300 GSM",
      "Normal finish",
      "Both-side reminder card available",
      "Best rate quantity ke according provide hota hai"
    ],
    keyFeatures: ["Premium 300 GSM", "Both-side printing", "Doctor desk recall", "Multiple sizes", "Dye-cut option"],
    qualificationQuestions: [
      "Sir, Reminder Card me size kya chahiye?"
    ],
    answerStyle:
      "Sir, Reminder Card me size kya chahiye? A5/A4 ka MOQ 1000 pcs hai, Pocket/9.5x7/Dye-cut ka MOQ 2000 pcs hai.",
    objections: {
      price: "Ok Sir, aap please size aur quantity share kar dijiye, team jaldi hi aapse connect karke quotation confirm karegi.",
      sample: `Sir, isme aap hamare latest Reminder Card samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge: ${sampleLinks.reminderCard}`,
      moq: "Sir, A5/A4 Reminder Card ka MOQ 1000 pcs hai. Pocket/9.5x7/Dye-cut ka MOQ 2000 pcs hai. Aapko kaunsa size chahiye?"
    }
  },
  {
    name: "Chit Pad",
    category: "Pharma Promotional Material",
    moq: "MOQ 100 pads.",
    aliases: ["chit pad", "chitpad", "doctor pad", "small pad", "cube pad", "table calendar chit pad"],
    sampleLink: sampleLinks.chitPad,
    shortDescription:
      "Doctor table par permanent rehne wala branded chit pad jo presentation aur brand recall improve karta hai.",
    specs: [
      "MOQ 100 pads",
      "Each pad: 200 chits/pages",
      "Paper: 80 GSM",
      "Har chit par watermark branding",
      "4-5 brands highlight ho jate hain"
    ],
    keyFeatures: [
      "Doctor table par permanently rehta hai",
      "Brand recall improve karta hai",
      "Presentation improve karta hai",
      "Watermark branding",
      "4-5 brand highlight"
    ],
    qualificationQuestions: ["Sir, Chit Pad me kitni quantity required hai aapko?"],
    answerStyle:
      "Sir, Chit Pad ka MOQ 100 pads hai. Isme 80 GSM paper ki 200 chits hoti hain aur har chit par watermark branding hoti hai. Aapko kitni quantity required hai?",
    objections: {
      price: "Ok Sir, aap please quantity share kar dijiye, team jaldi hi aapse connect karke quotation confirm karegi.",
      sample: `Sir, isme aap hamare latest Chit Pad samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge: ${sampleLinks.chitPad}`,
      moq: "Sir, Chit Pad ka MOQ 100 pads hai. Aapko kitni quantity required hai?"
    }
  },
  {
    name: "Chemist Order Book",
    category: "Pharma Promotional Material",
    moq: "MOQ 500 books.",
    aliases: ["chemist book", "chemist order book", "order book", "chemist pad"],
    sampleLink: sampleLinks.chemistBook,
    shortDescription:
      "Chemist counter par order taking aur brand recall ke liye useful branded order book.",
    specs: [
      "MOQ 500 books",
      "40 pages/leafs",
      "Inner: 80 GSM",
      "Size: 8.5 x 5.5 inch",
      "Centre pin binding",
      "Both-side printing",
      "Cover: 250 GSM with outer lamination"
    ],
    keyFeatures: ["Chemist counter utility", "Brand visibility", "Both-side print", "Laminated cover", "Bulk promotion"],
    qualificationQuestions: ["Sir, aapko kitni quantity required hai?"],
    answerStyle:
      "Sir, Chemist Order Book ka MOQ 500 books hai. Isme 80 GSM ke 40 pages/leafs, 8.5x5.5 inch size, both-side printing, centre pin binding aur 250 GSM laminated cover milta hai. Aapko kitni quantity required hai?",
    objections: {
      price: "Ok Sir, aap please quantity share kar dijiye, team jaldi hi aapse connect karke quotation confirm karegi.",
      sample: `Sir, isme aap hamare latest Chemist Book samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge: ${sampleLinks.chemistBook}`,
      moq: "Sir, Chemist Order Book ka MOQ 500 books hai. Aapko kitni quantity required hai?"
    }
  },
  {
    name: "Prescription Pad",
    category: "Pharma Promotional Material",
    moq: "MOQ 500 pads.",
    aliases: ["prescription pad", "rx pad", "doctor prescription pad", "pad"],
    sampleLink: sampleLinks.prescriptionPad,
    shortDescription:
      "Doctors ke prescription use ke liye branded pad, same specs as Chemist Book.",
    specs: [
      "MOQ 500 pads",
      "40 pages/leafs",
      "Inner: 80 GSM",
      "Size: 8.5 x 5.5 inch",
      "Centre pin binding",
      "Both-side printing",
      "Cover: 250 GSM with outer lamination"
    ],
    keyFeatures: ["Doctor utility product", "Brand recall", "Both-side print", "Laminated cover", "Professional format"],
    qualificationQuestions: ["Sir, aapko kitni quantity required hai?"],
    answerStyle:
      "Sir, Prescription Pad ka MOQ 500 pads hai. Isme 80 GSM ke 40 pages/leafs, 8.5x5.5 inch size, both-side printing, centre pin binding aur 250 GSM laminated cover milta hai. Aapko kitni quantity required hai?",
    objections: {
      price: "Ok Sir, aap please quantity share kar dijiye, team jaldi hi aapse connect karke quotation confirm karegi.",
      sample: `Sir, isme aap hamare latest Prescription Pad samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge: ${sampleLinks.prescriptionPad}`,
      moq: "Sir, Prescription Pad ka MOQ 500 pads hai. Aapko kitni quantity required hai?"
    }
  },
  {
    name: "E-Visual App",
    category: "Digital Pharma Promotion",
    moq: "Print MOQ nahi hota; charges sales team requirement dekhkar confirm karegi.",
    aliases: ["e visual", "e-visual", "evisual", "visual app", "android app", "tablet app", "digital visual aid", "ppt app", "presentation app"],
    sampleLink: sampleLinks.eVisualApp,
    shortDescription:
      "Android/tablet based E-Visual App for modern doctor detailing with PPT, animation, side indexing and smooth navigation.",
    specs: [
      "AI charges/rate commit nahi karega; sales team connect karegi",
      "First ask: design ready hai open/editable file me ya RX Design Hub ko design banana padega?",
      "Second ask: division-wise app chahiye ya normal/product-wise?",
      "Client provides: brand name, composition, logo, division name if applicable",
      "Team handles: design, MOA, benefits, clinical content, PPT, animation, Android app setup"
    ],
    keyFeatures: ["PPT creation", "Animation", "Android app setup", "Division-wise option", "Modern doctor detailing"],
    qualificationQuestions: [
      "Sir, aapka design ready hai open/editable file me, ya design hame banana padega?",
      "Sir, app aapko division-wise chahiye ya normal product-wise?"
    ],
    answerStyle:
      "Sir, E-Visual App me design, MOA, benefits, clinical content, PPT, animation aur Android app setup hamari team handle karti hai. Aapka design ready hai open/editable file me, ya design hame banana padega?",
    objections: {
      price: "Sir, E-Visual App ke charges requirement dekhkar sales team best confirm karegi. Pehle bata dijiye design ready hai open/editable file me ya hame banana padega?",
      sample: `Sir, isme aap hamare latest E-Visual App demo/samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge: ${sampleLinks.eVisualApp}`,
      app: "Sir, ye Android/tablet based digital presentation app hota hai jisme pharma products ko premium animation aur smooth navigation ke saath present kiya jata hai."
    }
  },
  {
    name: "Diary",
    category: "Corporate/Pharma Promotional Gift",
    moq: "Details baad me add honge; abhi team confirm karegi.",
    aliases: ["diary", "diaries", "doctor diary", "pharma diary", "dairy"],
    sampleLink: sampleLinks.diary,
    shortDescription: "Doctor/pharma gifting ke liye branded diary. Detailed specs later add honge.",
    specs: ["Detailed specs/pricing abhi AI share nahi karega", "Sales team requirement dekhkar confirm karegi"],
    keyFeatures: ["Branded pharma gifting", "Doctor recall", "Custom branding possible"],
    qualificationQuestions: ["Sir, Diary ke liye approx kitni quantity required hai?"],
    answerStyle: "Sir, Diary ke details sales team aapko confirm kar degi. Aap quantity aur requirement share kar dijiye.",
    objections: {
      price: "Sir, Diary ke liye details aur quotation sales team confirm kar degi. Aap quantity share kar dijiye."
    }
  },
  {
    name: "Calendar",
    category: "Corporate/Pharma Promotional Gift",
    moq: "Details baad me add honge; abhi team confirm karegi.",
    aliases: ["calendar", "calender", "table calendar", "desk calendar", "wall calendar"],
    sampleLink: sampleLinks.calendar,
    shortDescription: "Doctor desk/wall branding ke liye calendar. Detailed specs later add honge.",
    specs: ["Detailed specs/pricing abhi AI share nahi karega", "Sales team requirement dekhkar confirm karegi"],
    keyFeatures: ["Year-round brand visibility", "Doctor desk/clinic placement", "Custom branding possible"],
    qualificationQuestions: ["Sir, Calendar ke liye approx kitni quantity required hai?"],
    answerStyle: "Sir, Calendar ke details sales team aapko confirm kar degi. Aap quantity aur requirement share kar dijiye.",
    objections: {
      price: "Sir, Calendar ke liye details aur quotation sales team confirm kar degi. Aap quantity share kar dijiye."
    }
  }
];

export const fixedFaqs = [
  {
    keywords: ["price", "rate", "cost", "kitna", "charges", "quotation", "quote", "mrp", "amount", "daam", "rate list", "keemat"],
    answer:
      "Ok Sir, aap please quantity share kar dijiye, team jaldi hi aapse connect karegi."
  },
  {
    keywords: ["sample", "catalog", "catalogue", "design sample", "portfolio", "photos", "image", "video", "sample chahiye"],
    answer:
      "Sir, product ke sample link me aap hamare latest samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge."
  },
  {
    keywords: ["call", "phone", "baat", "contact", "callback", "call karo"],
    answer:
      "Ji Sir, team aapse jaldi connect karegi. Main sales representative ko assign kar deta hun."
  },
  {
    keywords: ["urgent", "jaldi", "immediate", "today", "asap", "fast", "turant"],
    answer:
      "Ji Sir, main urgent basis par sales representative assign karta hun. Aap product aur quantity share kar dijiye."
  },
  {
    keywords: ["location", "address", "map", "office", "lucknow", "pata"],
    answer:
      `Sir, hamara office Lucknow me hai aur PAN India service available hai. Location: ${companyKnowledge.mapsLink}`
  },
  {
    keywords: ["design bhi", "design karte", "sirf design", "only design", "design only"],
    answer:
      "Ji Sir, hame bas Brand Name aur Composition chahiye, baaki design/content hamari team handle kar deti hai. Sirf design work bhi accept hai."
  },
  {
    keywords: ["printing only", "sirf printing", "design ready", "print only", "editable file", "open file"],
    answer:
      "Ji Sir, agar design ready hai to sirf printing bhi ho jaegi. Aap product, quantity aur design file type share kar dijiye."
  },
  {
    keywords: ["delivery", "dispatch", "courier", "transport", "ship", "pan india"],
    answer:
      "Ji Sir, PAN India courier/transport ho jaega. Timeline product, quantity aur approval ke according team confirm karegi."
  },
  {
    keywords: ["payment", "advance", "upi", "gst", "invoice"],
    answer:
      "Sir, payment terms, GST/invoice aur advance details order requirement ke according team confirm karegi."
  }
];

export function findRelevantKnowledge(customerMessage = "") {
  const text = customerMessage.toLowerCase();

  const matchedProducts = products.filter((product) => {
    return product.aliases.some((alias) => text.includes(alias.toLowerCase()));
  });

  const matchedFaqs = fixedFaqs.filter((faq) => {
    return faq.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  });

  return {
    company: companyKnowledge,
    sampleLinks,
    products: matchedProducts.length ? matchedProducts.slice(0, 4) : products.slice(0, 8),
    faqs: matchedFaqs.slice(0, 5)
  };
}

export function buildKnowledgePrompt(customerMessage = "") {
  const relevant = findRelevantKnowledge(customerMessage);

  return `
COMPANY KNOWLEDGE:
Business Name: ${relevant.company.businessName}
Location: ${relevant.company.location}
Map Link: ${relevant.company.mapsLink}
Service Area: ${relevant.company.serviceArea}
Opening Intro: ${relevant.company.openingIntro}
Intro: ${relevant.company.shortIntro}
Positioning: ${relevant.company.positioning}
Specialties: ${relevant.company.specialties.join(" | ")}
Process: ${relevant.company.process.join(" -> ")}
Delivery: ${relevant.company.delivery}
Payment: ${relevant.company.payment}
Pricing Policy: ${relevant.company.pricingPolicy}
Tone: ${relevant.company.tone}

SAMPLE LINKS:
Visual Aid: ${relevant.sampleLinks.visualAid}
Reminder Card: ${relevant.sampleLinks.reminderCard}
Chit Pad: ${relevant.sampleLinks.chitPad}
Chemist Book: ${relevant.sampleLinks.chemistBook}
Prescription Pad: ${relevant.sampleLinks.prescriptionPad}
E-Visual App: ${relevant.sampleLinks.eVisualApp}
Diary: ${relevant.sampleLinks.diary}
Calendar: ${relevant.sampleLinks.calendar}

RELEVANT PRODUCTS:
${relevant.products
  .map(
    (p, index) => `
${index + 1}. ${p.name}
Category: ${p.category}
MOQ: ${p.moq}
Description: ${p.shortDescription}
Specs: ${(p.specs || []).join(" | ")}
Features/USP: ${(p.keyFeatures || []).join(" | ")}
Best Next Question: ${(p.qualificationQuestions || []).join(" | ")}
Preferred Answer Style: ${p.answerStyle || "Use short product-specific answer and ask one next question."}
Sample Link: ${p.sampleLink || ""}
Objection Handling: ${Object.values(p.objections || {}).join(" ")}
`
  )
  .join("\n")}

MATCHING FAQ ANSWERS:
${relevant.faqs.map((f, i) => `${i + 1}. ${f.answer}`).join("\n") || "No specific FAQ matched. Use product knowledge and ask one useful next question."}

STRICT SALES RULES:
1. Never ask customer budget or expected price.
2. Never share exact pricing, rates, price list, discount, or final quotation.
3. If customer asks rate/price/quotation, reply close to: "Ok Sir, aap please quantity share kar dijiye, team jaldi hi aapse connect karegi." If product needs pages/size, ask that one missing detail.
4. First greeting should be short and warm. Later replies should be 2 short lines with blank line spacing.
5. Ask only one question at a time: product first, then quantity, then size/pages depending on product.
6. Do not ask Brand Name/Composition at starting stage. Only after order confirmation, suggest: "Sir, order confirm hone ke baad Brand Name aur Composition bhej dijiyega."
7. If unknown/detail not in knowledge, say: "Sir, is detail ke liye hamari team aapko accurate update de degi."
8. Use Hinglish if customer uses Hindi/English mix.
9. Use Sir default, but if customer name is available use name naturally instead of Sir every time. Do not use Mam.
10. Minimal professional emoji only, not in every message.
11. If customer asks sample/catalogue, send correct product sample link and say: "Sir, isme aap hamare latest samples check kar sakte hain. Scroll karke neeche bahut se samples mil jayenge."
12. If customer says call karo, urgent, quotation, payment/order, shares quantity/pages, or negotiates price, mark handoff_required true.
13. If multiple products are mentioned, acknowledge in one line and collect requirement product-by-product, one question at a time.
14. Design-only and printing-only work both accepted.
15. Do not mention that you are AI.
16. Never send one long paragraph. Use \n\n between short WhatsApp lines.
`;
}
