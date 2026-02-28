import { sidereal, solar, nutation, moonposition, julian } from "https://esm.sh/astronomia@4.0.0";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

//////////////////////////////////////////////////
// TYPES
//////////////////////////////////////////////////

interface Shell {
  id: number;
  up: "UP" | "DN";
  pos: [number, number]; // [x, y] relative within house
}

interface CastResult {
  entropy_bits: number;
  arudha: number;
  question?: string;
  lang?: string;
  counts: { total_up: number; total_dn: number; };
  board: Record<number, Shell[]>;
  birth_context?: { lat: number; lon: number; time: string; };
  prasna_context?: { lat: number; lon: number; time: string; };
  janma_lagna?: { house: number; sign: string; degrees: number; };
  transit_planets?: Record<string, { house: number; degrees: number; }>;
  time_piles: { past: number; present: number; future: number; };
}

//////////////////////////////////////////////////
// ASTROLOGY ENGINE
//////////////////////////////////////////////////

function dateToJD(date: Date): number {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  let jd = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  jd += (hours - 12) / 24 + minutes / 1440 + seconds / 86400;
  return jd;
}

function getLahiriAyanamsa(jd: number): number {
  const t = (jd - 2451545.0) / 36525.0;
  return 22.466667 + 1.396667 * t + 0.000309 * t * t;
}

function longToHouse(long: number, ayanamsa: number): number {
  const siderealLong = (long - ayanamsa + 360) % 360;
  return Math.floor(siderealLong / 30) + 1;
}

function getRashiName(house: number): string {
  const rashis = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Thula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena"];
  return rashis[house - 1];
}

async function calculateAstro(lat: number, lon: number, timeStr: string, isBirth: boolean) {
  const date = new Date(timeStr);
  const jd = dateToJD(date);
  const ayanamsa = getLahiriAyanamsa(jd);

  if (isBirth) {
    const gst = sidereal.apparent(jd);
    const lst = (gst + lon / 15 + 24) % 24;
    const ramc = lst * 15;

    // Correct way to get true obliquity in astronomia 4.x
    const meanEps = nutation.meanObliquity(jd);
    const [dPsi, dEps] = nutation.nutation(jd);
    const eps = meanEps + dEps;

    const phiRad = lat * Math.PI / 180;
    const ramcRad = ramc * Math.PI / 180;
    const epsRad = eps * Math.PI / 180;
    const ascRad = Math.atan2(Math.cos(ramcRad), - (Math.sin(ramcRad) * Math.cos(epsRad) + Math.tan(phiRad) * Math.sin(epsRad)));
    let ascLong = (ascRad * 180 / Math.PI + 360) % 360;
    const house = longToHouse(ascLong, ayanamsa);
    return { lagna: { house, sign: getRashiName(house), degrees: (ascLong - ayanamsa + 360) % 360 } };
  } else {
    const planets: any = {};
    const sunL = solar.apparentLongitude(jd);
    planets["Sun"] = { house: longToHouse(sunL, ayanamsa), degrees: sunL, sign: getRashiName(longToHouse(sunL, ayanamsa)) };
    const moonPos = moonposition.position(jd);
    const moonL = moonPos.lon * 180 / Math.PI;
    planets["Moon"] = { house: longToHouse(moonL, ayanamsa), degrees: (moonL + 360) % 360, sign: getRashiName(longToHouse(moonL, ayanamsa)) };

    const pList = ["Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu", "Uranus"];
    for (const p of pList) {
      const offset = (Math.sin(jd * (pList.indexOf(p) + 3)) * 180);
      const pos = (sunL + offset + 360) % 360;
      const house = longToHouse(pos, ayanamsa);
      planets[p] = { house, degrees: pos, sign: getRashiName(house) };
    }

    // Calculate drishti (aspects) for transit planets
    const drishti = calculateDrishtiForPlanets(planets);

    return { planets, drishti };
  }
}

// Calculate Vedic aspects (drishti) for planets
function calculateDrishtiForPlanets(planets: Record<string, { house: number }>): Record<string, { house: number; aspects: number[] }> {
  const result: Record<string, { house: number; aspects: number[] }> = {};

  Object.entries(planets).forEach(([planet, data]) => {
    const house = data.house;
    const aspects: number[] = [];

    // All planets aspect 7th house (opposition)
    const seventh = ((house + 6 - 1) % 12) + 1;
    aspects.push(seventh);

    // Special aspects
    if (planet === "Mars") {
      const fourth = ((house + 3 - 1) % 12) + 1;
      const eighth = ((house + 7 - 1) % 12) + 1;
      aspects.push(fourth, eighth);
    } else if (planet === "Jupiter") {
      const fifth = ((house + 4 - 1) % 12) + 1;
      const ninth = ((house + 8 - 1) % 12) + 1;
      aspects.push(fifth, ninth);
    } else if (planet === "Saturn") {
      const third = ((house + 2 - 1) % 12) + 1;
      const tenth = ((house + 9 - 1) % 12) + 1;
      aspects.push(third, tenth);
    } else if (planet === "Rahu" || planet === "Ketu") {
      const fifth = ((house + 4 - 1) % 12) + 1;
      const ninth = ((house + 8 - 1) % 12) + 1;
      aspects.push(fifth, ninth);
    }

    result[planet] = { house, aspects: [...new Set(aspects)] };
  });

  return result;
}

//////////////////////////////////////////////////
// CAST ENGINE
//////////////////////////////////////////////////

const encoder = new TextEncoder();
async function sha512(input: string): Promise<Uint8Array> {
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-512", data);
  return new Uint8Array(hash);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) + BigInt(b);
  return result;
}

async function deriveEntropy(seed: string, tag: string): Promise<bigint> {
  return bytesToBigInt(await sha512(`${seed}:${tag}`));
}

async function simulateCast(rawBits: string, q?: string, lang?: string, birth?: any, prasna?: any): Promise<CastResult> {
  const seed = rawBits;
  const arudha = Number((await deriveEntropy(seed, "arudha")) % 12n) + 1;
  const board: Record<number, Shell[]> = {};
  for (let i = 1; i <= 12; i++) board[i] = [];

  let total_up = 0, total_dn = 0;
  for (let i = 0; i < 108; i++) {
    const e = await deriveEntropy(seed, `shell:${i}`);
    const house = Number((e >> 1n) % 12n) + 1;
    const isUp = (e & 1n) === 1n;
    if (isUp) total_up++; else total_dn++;

    // Spatial component: relative position within house (0-100)
    const px = Number((e >> 10n) % 100n);
    const py = Number((e >> 17n) % 100n);

    board[house].push({ id: i + 1, up: isUp ? "UP" : "DN", pos: [px, py] });
  }

  const pastCount = board[12].length + board[1].length + board[2].length;
  const presentCount = board[3].length + board[4].length + board[5].length + board[6].length;
  const futureCount = board[7].length + board[8].length + board[9].length + board[10].length + board[11].length;

  function getRem(c: number) { const r = c % 8; return r === 0 ? 8 : r; }

  let janma_lagna = undefined;
  if (birth && birth.lat) {
    const res = await calculateAstro(birth.lat, birth.lon, birth.time, true);
    janma_lagna = res.lagna;
  }

  let transit_planets = undefined;
  let transit_drishti = undefined;
  if (prasna && prasna.lat) {
    const res = await calculateAstro(prasna.lat, prasna.lon, prasna.time, false);
    transit_planets = res.planets;
    transit_drishti = res.drishti;
  }

  return {
    entropy_bits: seed.length, arudha, question: q, lang, counts: { total_up, total_dn },
    board, janma_lagna, transit_planets, transit_drishti,
    time_piles: { past: getRem(pastCount), present: getRem(presentCount), future: getRem(futureCount) }
  };
}

//////////////////////////////////////////////////
// EXPORT FORMATTING
//////////////////////////////////////////////////

interface ExportData {
  cast: CastResult;
  structure: any;
  advice: any;
  format: 'markdown' | 'pdf' | 'html';
  lang: string;
  timestamp: string;
  chakraImage?: string; // Base64 encoded PNG image of the chakra
}

// Generate ASCII representation of the Prasna Chakra (simplified for export)
function generateChakraASCII(cast: CastResult, t: Record<string, string>): string {
  const { board, time_piles } = cast;
  const houses: string[][] = Array.from({ length: 12 }, () => []);

  // Distribute shells to houses (up is "UP" | "DN")
  Object.entries(board).forEach(([houseNum, shells]) => {
    const h = parseInt(houseNum) - 1;
    if (h >= 0 && h < 12) {
      houses[h] = shells.map(s => s.up === "UP" ? 'U' : 'D');
    }
  });

  // Calculate shell counts per house
  const houseCounts = houses.map((shells, i) => {
    const up = shells.filter(s => s === 'U').length;
    const down = shells.filter(s => s === 'D').length;
    return { house: i + 1, up, down, total: shells.length };
  });

  // Calculate auspiciousness based on kavane distribution rules
  function getAuspiciousness(h: typeof houseCounts[0]) {
    const isOddHouse = [1, 3, 5, 7, 9, 11].includes(h.house);
    const upRatio = h.total > 0 ? h.up / h.total : 0;

    // Rule: Together (kavane grouped) = auspicious
    // Rule: Increasing in odd houses = auspicious
    // Rule: Increasing in even houses = inauspicious
    // Rule: Placing on lines = inauspicious

    let marker = '';
    let nature = t.neutral || 'Neutral';

    if (isOddHouse) {
      if (upRatio >= 0.6) {
        nature = t.benefic || 'Benefic';
        marker = ' ✓'; // Auspicious
      } else if (upRatio < 0.4) {
        nature = t.malefic || 'Malefic';
        marker = ' ✗'; // Inauspicious
      }
    } else {
      if (upRatio <= 0.4) {
        nature = t.benefic || 'Benefic';
        marker = ' ✓'; // Auspicious
      } else if (upRatio > 0.6) {
        nature = t.malefic || 'Malefic';
        marker = ' ✗'; // Inauspicious
      }
    }

    return { nature, marker };
  }

  // Build ASCII visualization
  let ascii = `\n## ${t.prasnaChakra || 'Prasna Chakra'}\n\n`;
  ascii += `${t.kavanaVisualization || 'Kavana (Shell) Distribution'}:\n\n`;

  // Top row (Houses 12, 11, 10, 9, 8, 7) - Northern style
  ascii += '╔══════════╦══════════╦══════════╦══════════╦══════════╦══════════╗\n';
  ascii += '║   H12    ║   H11    ║   H10    ║    H9    ║    H8    ║    H7    ║\n';
  ascii += '╠══════════╬══════════╬══════════╬══════════╬══════════╬══════════╣\n';

  // Shell counts for top row
  const topRow = [11, 10, 9, 8, 7, 6].map(i => houseCounts[i]);
  ascii += topRow.map(h => `║ U:${h.up.toString().padStart(2)}   ║`).join('').replace(/║$/, '') + '\n';
  ascii += topRow.map(h => `║ D:${h.down.toString().padStart(2)}   ║`).join('').replace(/║$/, '') + '\n';
  ascii += '╚══════════╩══════════╩══════════╩══════════╩══════════╩══════════╝\n\n';

  // Bottom row (Houses 1, 2, 3, 4, 5, 6)
  ascii += '╔══════════╦══════════╦══════════╦══════════╦══════════╦══════════╗\n';
  ascii += '║    H1    ║    H2    ║    H3    ║    H4    ║    H5    ║    H6    ║\n';
  ascii += '╠══════════╬══════════╬══════════╬══════════╬══════════╬══════════╣\n';

  // Shell counts for bottom row
  const bottomRow = [0, 1, 2, 3, 4, 5].map(i => houseCounts[i]);
  ascii += bottomRow.map(h => `║ U:${h.up.toString().padStart(2)}   ║`).join('').replace(/║$/, '') + '\n';
  ascii += bottomRow.map(h => `║ D:${h.down.toString().padStart(2)}   ║`).join('').replace(/║$/, '') + '\n';
  ascii += '╚══════════╩══════════╩══════════╩══════════╩══════════╩══════════╝\n\n';

  // Legend
  ascii += `${t.shellLegend || 'Shells'}: ${t.upSymbol || 'U (Upright)'} = ${t.benefic || 'Benefic'}, ${t.downSymbol || 'D (Reversed)'} = ${t.malefic || 'Malefic'}\n`;
  ascii += `✓ = ${t.benefic || 'Auspicious'}, ✗ = ${t.malefic || 'Inauspicious'}\n\n`;

  // Time Piles Section
  if (time_piles) {
    ascii += `### ${t.timePiles || 'Time Piles'}\n\n`;
    ascii += `- **${t.past || 'Past'} (H12-H2):** ${time_piles.past} shells\n`;
    ascii += `- **${t.present || 'Present'} (H3-H6):** ${time_piles.present} shells\n`;
    ascii += `- **${t.future || 'Future'} (H7-H11):** ${time_piles.future} shells\n\n`;

    // Pile analysis
    const maxPile = Math.max(time_piles.past, time_piles.present, time_piles.future);
    if (maxPile === time_piles.present) {
      ascii += `*${t.present || 'Present'} pile strongest - indicates immediate action is favored*\n\n`;
    } else if (maxPile === time_piles.future) {
      ascii += `*${t.future || 'Future'} pile strongest - indicates patience will be rewarded*\n\n`;
    } else {
      ascii += `*${t.past || 'Past'} pile strongest - indicates resolution of past karma*\n\n`;
    }
  }

  // Detailed breakdown with auspiciousness
  ascii += `### ${t.houseLegend || 'House'} ${t.breakdown || 'Breakdown'}\n\n`;
  ascii += `| ${t.house || 'House'} | Total | Upright | Reversed | ${t.nature || 'Nature'} |\n`;
  ascii += `|-------|-------|---------|----------|----------|\n`;
  houseCounts.forEach(h => {
    const { nature, marker } = getAuspiciousness(h);
    ascii += `| ${h.house.toString().padStart(2)} | ${h.total.toString().padStart(2)} | ${h.up.toString().padStart(2)} | ${h.down.toString().padStart(2)} | ${nature}${marker} |\n`;
  });

  return ascii;
}

function generateMarkdown(data: ExportData): string {
  const { cast, structure, advice, lang, timestamp } = data;
  const t = getI18N(lang);

  let md = `# ${t.exportTitle || 'Ashtamangala Prasna Reading'}\n\n`;
  md += `**${t.date || 'Date'}:** ${timestamp}\n`;
  md += `**${t.language || 'Language'}:** ${lang.toUpperCase()}\n\n`;

  // Query Section
  md += `## ${t.query || 'Sacred Query'}\n\n`;
  const questionStr = typeof cast.question === 'string' ? cast.question : (cast.question ? String(cast.question) : (t.generalReading || 'General Reading'));
  md += `> ${questionStr}\n\n`;

  // Technical Cast Details
  md += `## ${t.technicalDetails || 'Technical Cast Details'}\n\n`;
  md += `### ${t.shellDistribution || 'Shell Distribution'}\n`;
  md += `- **${t.upright || 'Upright'}:** ${cast.counts.total_up}\n`;
  md += `- **${t.reversed || 'Reversed'}:** ${cast.counts.total_dn}\n`;
  md += `- **${t.arudha || 'Arudha Lagna'}:** House ${cast.arudha}\n`;

  if (cast.janma_lagna) {
    md += `- **${t.janmaLagna || 'Janma Lagna'}:** ${cast.janma_lagna.sign} (${cast.janma_lagna.degrees.toFixed(2)}°)\n`;
  }

  md += `\n### ${t.timePiles || 'Time Piles'}\n`;
  md += `- **${t.past || 'Past'}:** ${cast.time_piles.past}\n`;
  md += `- **${t.present || 'Present'}:** ${cast.time_piles.present}\n`;
  md += `- **${t.future || 'Future'}:** ${cast.time_piles.future}\n\n`;

  // Add Prasna Chakra ASCII visualization
  md += generateChakraASCII(cast, t);
  md += '\n';

  if (cast.transit_planets && Object.keys(cast.transit_planets).length > 0) {
    md += `### ${t.planetaryPositions || 'Planetary Positions'}\n\n`;
    md += `| ${t.planet || 'Planet'} | ${t.house || 'House'} | ${t.degrees || 'Degrees'} |\n`;
    md += `|----------|-------|---------|\n`;
    Object.entries(cast.transit_planets).forEach(([planet, data]: [string, any]) => {
      md += `| ${planet} | ${data.house} | ${data.degrees.toFixed(2)}° |\n`;
    });
    md += `\n`;
  }

  // Structure Analysis
  md += `---\n\n`;
  md += `# ${structure.analysis_title || t.celestialStructure || 'Celestial Structure'}\n\n`;

  structure.sections?.forEach((section: any, index: number) => {
    md += `## ${index + 1}. ${section.title || 'Section ' + (index + 1)}\n\n`;
    
    const technicalText = String(section.technical_rishi || section.technical || '');
    if (technicalText.trim().length > 0) {
      md += `### ${t.technicalPerspective || 'Technical Perspective'}\n\n`;
      md += `${technicalText}\n\n`;
    }
    
    const modernText = String(section.colloquial_modern || section.colloquial || '');
    if (modernText.trim().length > 0) {
      md += `### ${t.modernInterpretation || 'Modern Interpretation'}\n\n`;
      md += `${modernText}\n\n`;
    }
    
    md += `---\n\n`;
  });

  if (structure.concluding_insight) {
    md += `## ${t.concludingInsight || 'Concluding Insight'}\n\n`;
    md += `> ${String(structure.concluding_insight)}\n\n`;
  }

  // Spiritual Guidance
  const guidance = advice.spiritual_guidance || advice;
  md += `---\n\n`;
  
  // Blessing Section (if counsel_title exists)
  if (guidance.counsel_title) {
    md += `# ${t.blessingTitle || 'Blessing of Light and Overcoming'}\n\n`;
    md += `> *"${String(guidance.counsel_title)}"*\n\n`;
    md += `---\n\n`;
  }
  
  md += `# ${t.spiritualGuidance || 'Spiritual Guidance'}\n\n`;

  // Handle narrative - ensure it's always an array
  let narrative = guidance.guidance_narrative || guidance.narrative_sections || [];
  if (!Array.isArray(narrative)) {
    // If it's a string or object, wrap it in an array
    if (typeof narrative === 'string' && narrative.trim()) {
      narrative = [{ heading: t.sacredGuidance || 'Sacred Guidance', content: narrative }];
    } else if (typeof narrative === 'object' && narrative !== null) {
      // Convert object to array of entries
      narrative = Object.entries(narrative).map(([key, value]) => ({
        heading: key,
        content: typeof value === 'string' ? value : JSON.stringify(value)
      }));
    } else {
      narrative = [];
    }
  }
  narrative.forEach((item: any, index: number) => {
    if (!item) return;
    const content = item.content || item.body || '';
    if (typeof content === 'string' && content.trim().length > 0) {
      md += `## ${index + 1}. ${item.heading || item.title || (t.sacredGuidance || 'Guidance')}\n\n`;
      md += `${content}\n\n`;
      md += `---\n\n`;
    }
  });

  // Remedies
  let remedies = guidance.specific_remedies || [];
  if (!Array.isArray(remedies)) {
    remedies = [];
  }
  if (remedies.length > 0) {
    md += `## ${t.sacredRemedies || 'Sacred Remedies'}\n\n`;
    remedies.forEach((remedy: any, index: number) => {
      const remedyText = typeof remedy === 'string' ? remedy : (remedy.title || remedy.name || JSON.stringify(remedy));
      md += `${index + 1}. ${remedyText}\n`;
    });
    md += `\n---\n\n`;
  }

  // Final Prediction
  if (guidance.final_prediction) {
    md += `## ${t.finalPrediction || 'Final Prediction'}\n\n`;
    // Handle both string and object formats
    let predictionText;
    if (typeof guidance.final_prediction === 'string') {
      predictionText = guidance.final_prediction;
    } else if (typeof guidance.final_prediction === 'object') {
      // Format object with timing, result, certainty, conditions
      const fp = guidance.final_prediction;
      const parts = [];
      if (fp.timing) parts.push(`**Timing:** ${fp.timing}`);
      if (fp.result) parts.push(`**Result:** ${fp.result}`);
      if (fp.certainty) parts.push(`**Certainty:** ${fp.certainty}`);
      if (fp.conditions && Array.isArray(fp.conditions) && fp.conditions.length > 0) {
        parts.push(`**Conditions:** ${fp.conditions.join(', ')}`);
      }
      predictionText = parts.length > 0 ? parts.join('\n\n') : JSON.stringify(fp);
    } else {
      predictionText = String(guidance.final_prediction);
    }
    md += `> ${predictionText}\n\n`;
  }

  // Rishi Counsel Note (always at the end, before footer)
  md += `---\n\n`;
  md += `> 🙏 **${t.seekRishiCounsel || 'For deeper guidance in this matter, seek the counsel of a qualified Rishi.'}**\n\n`;

  // Footer
  md += `---\n\n`;
  md += `*${String(t.generatedBy || 'Generated by Ashtamangala Prasna')}*\n`;
  md += `*${String(t.medicalDisclaimer || 'Remedies refer to spiritual activities for alleviation, not medical advice. Consult professionals for health concerns.')}*\n`;
  md += `*${String(t.sacredWisdom || 'May the wisdom of the ancients guide your path')}*\n`;

  return md;
}

function generateHTML(data: ExportData): string {
  const md = generateMarkdown(data);
  // Ensure md is a string
  if (typeof md !== 'string') {
    console.error('generateMarkdown did not return a string:', typeof md);
    return '<html><body>Error generating HTML</body></html>';
  }
  // Simple markdown to HTML conversion
  let html = md
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>')
    .replace(/\|(.*)\|/g, '<tr><td>$1</td></tr>')
    .replace(/^(\d+)\. (.*$)/gm, '<li>$2</li>')
    .replace(/---/g, '<hr>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html lang="${data.lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ashtamangala Prasna Reading</title>
  <style>
    body { font-family: 'Palatino', 'Georgia', serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; background: #faf8f5; color: #333; line-height: 1.8; }
    h1 { color: #8b4513; border-bottom: 3px solid #d4af37; padding-bottom: 10px; }
    h2 { color: #a0522d; margin-top: 30px; }
    h3 { color: #cd853f; }
    blockquote { border-left: 4px solid #d4af37; padding-left: 20px; margin: 20px 0; font-style: italic; color: #666; }
    hr { border: none; border-top: 1px solid #d4af37; margin: 30px 0; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    td { padding: 10px; border: 1px solid #ddd; }
    li { margin: 10px 0; }
    strong { color: #8b4513; }
    em { color: #666; }
  </style>
</head>
<body>
  ${html}
</body>
</html>`;
}

function getI18N(lang: string): Record<string, string> {
  const i18n: Record<string, Record<string, string>> = {
    en: {
      exportTitle: "Ashtamangala Prasna Reading",
      prasnaChakra: "Prasna Chakra",
      kavanaVisualization: "Kavana (Shell) Distribution",
      chakraVisualization: "Prasna Chakra Visualization",
      houseLegend: "Houses",
      housesTop: "Houses 7-12 (Top)",
      housesBottom: "Houses 1-6 (Bottom)",
      nature: "Nature",
      benefic: "Benefic",
      malefic: "Malefic",
      neutral: "Neutral",
      shellLegend: "Shells",
      upSymbol: "U (Upright)",
      downSymbol: "D (Reversed)",
      date: "Date",
      language: "Language",
      query: "Sacred Query",
      generalReading: "General Reading",
      technicalDetails: "Technical Cast Details",
      shellDistribution: "Shell Distribution",
      upright: "Upright",
      reversed: "Reversed",
      arudha: "Arudha Lagna",
      janmaLagna: "Janma Lagna",
      timePiles: "Time Piles",
      past: "Past",
      present: "Present",
      future: "Future",
      planetaryPositions: "Planetary Positions",
      planet: "Planet",
      house: "House",
      degrees: "Degrees",
      celestialStructure: "Celestial Structure",
      technicalPerspective: "Technical Perspective",
      astrologicalSignificance: "Astrological Significance",
      detailedContext: "Detailed Context",
      modernInterpretation: "Modern Interpretation",
      concludingInsight: "Concluding Insight",
      spiritualGuidance: "Spiritual Guidance",
      blessingTitle: "Blessing of Light and Overcoming",
      sacredGuidance: "Sacred Guidance",
      seekRishiCounsel: "For deeper guidance in this matter, seek the counsel of a qualified Rishi.",
      deeperWisdom: "Deeper Wisdom",
      practicalApplication: "Practical Application",
      sacredRemedies: "Sacred Remedies",
      finalPrediction: "Final Prediction",
      generatedBy: "Generated by Rishi Ashtamangala Prasna",
      medicalDisclaimer: "Remedies refer to spiritual activities for alleviation, not medical advice. Consult professionals for health concerns.",
      sacredWisdom: "May the wisdom of the ancients guide your path",
      breakdown: "Breakdown",
      total: "Total",
    },
    es: {
      exportTitle: "Lectura de Prasna Ashtamangala",
      prasnaChakra: "Prasna Chakra",
      kavanaVisualization: "Distribución de Kavana (Conchas)",
      chakraVisualization: "Visualización del Prasna Chakra",
      houseLegend: "Casas",
      housesTop: "Casas 7-12 (Arriba)",
      housesBottom: "Casas 1-6 (Abajo)",
      nature: "Naturaleza",
      benefic: "Benéfico",
      malefic: "Maléfico",
      neutral: "Neutral",
      shellLegend: "Conchas",
      upSymbol: "A (Arriba)",
      downSymbol: "B (Abajo)",
      date: "Fecha",
      language: "Idioma",
      query: "Consulta Sagrada",
      generalReading: "Lectura General",
      technicalDetails: "Detalles Técnicos del Lanzamiento",
      shellDistribution: "Distribución de Conchas",
      upright: "Derecho",
      reversed: "Invertido",
      arudha: "Lagna Arudha",
      janmaLagna: "Lagna de Nacimiento",
      timePiles: "Pilas Temporales",
      past: "Pasado",
      present: "Presente",
      future: "Futuro",
      planetaryPositions: "Posiciones Planetarias",
      planet: "Planeta",
      house: "Casa",
      degrees: "Grados",
      celestialStructure: "Estructura Celestial",
      technicalPerspective: "Perspectiva Técnica",
      astrologicalSignificance: "Significado Astrológico",
      detailedContext: "Contexto Detallado",
      modernInterpretation: "Interpretación Moderna",
      concludingInsight: "Visión Conclusiva",
      spiritualGuidance: "Guía Espiritual",
      blessingTitle: "Bendición de Luz y Superación",
      sacredGuidance: "Guía Sagrada",
      seekRishiCounsel: "Para orientación más profunda, busque el consejo de un Rishi calificado.",
      deeperWisdom: "Sabiduría Profunda",
      practicalApplication: "Aplicación Práctica",
      sacredRemedies: "Remedios Sagrados",
      finalPrediction: "Predicción Final",
      generatedBy: "Generado por Rishi Ashtamangala Prasna",
      medicalDisclaimer: "Los remedios son actividades espirituales para aliviar, no consejo médico. Consulte profesionales para problemas de salud.",
      sacredWisdom: "Que la sabiduría de los ancestros guíe tu camino",
      breakdown: "Desglose",
      total: "Total",
    },
    it: {
      exportTitle: "Lettura Prasna Ashtamangala",
      prasnaChakra: "Prasna Chakra",
      kavanaVisualization: "Distribuzione Kavana (Conchiglie)",
      chakraVisualization: "Visualizzazione del Prasna Chakra",
      houseLegend: "Case",
      housesTop: "Case 7-12 (Sopra)",
      housesBottom: "Case 1-6 (Sotto)",
      nature: "Natura",
      benefic: "Benefico",
      malefic: "Malefico",
      neutral: "Neutrale",
      shellLegend: "Conchiglie",
      upSymbol: "S (Su)",
      downSymbol: "G (Giù)",
      date: "Data",
      language: "Lingua",
      query: "Domanda Sacra",
      generalReading: "Lettura Generale",
      technicalDetails: "Dettagli Tecnici del Lancio",
      shellDistribution: "Distribuzione delle Conchiglie",
      upright: "Dritto",
      reversed: "Rovescio",
      arudha: "Lagna Arudha",
      janmaLagna: "Lagna di Nascita",
      timePiles: "Pile Temporali",
      past: "Passato",
      present: "Presente",
      future: "Futuro",
      planetaryPositions: "Posizioni Planetarie",
      planet: "Pianeta",
      house: "Casa",
      degrees: "Gradi",
      celestialStructure: "Struttura Celeste",
      technicalPerspective: "Prospettiva Tecnica",
      astrologicalSignificance: "Significato Astrologico",
      detailedContext: "Contesto Dettagliato",
      modernInterpretation: "Interpretazione Moderna",
      concludingInsight: "Visione Conclusiva",
      spiritualGuidance: "Guida Spirituale",
      blessingTitle: "Benedizione di Luce e Superamento",
      sacredGuidance: "Guida Sacra",
      seekRishiCounsel: "Per una guida più profonda, cerca il consiglio di un Rishi qualificato.",
      deeperWisdom: "Saggezza Profonda",
      practicalApplication: "Applicazione Pratica",
      sacredRemedies: "Rimedi Sacri",
      finalPrediction: "Predizione Finale",
      generatedBy: "Generato da Rishi Ashtamangala Prasna",
      medicalDisclaimer: "I rimedi sono attività spirituali per alleviare, non consigli medici. Consulta professionisti per problemi di salute.",
      sacredWisdom: "Che la saggezza degli antichi guidi il tuo cammino",
      breakdown: "Dettaglio",
      total: "Totale",
    }
  };
  return i18n[lang] || i18n.en;
}

//////////////////////////////////////////////////
// AI INTERPRETATION
//////////////////////////////////////////////////

const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish (Español)",
  it: "Italian (Italiano)"
};

function getFullLangName(code: string): string {
  return LANG_NAMES[code] || "English";
}

async function callAI(systemPrompt: string, userPrompt: string) {
  const KEY = Deno.env.get("DEEPSEEK_API_KEY") || Deno.env.get("GEMINI_API_KEY");
  const isDeepseek = !!Deno.env.get("DEEPSEEK_API_KEY");
  const res = await fetch(isDeepseek ? "https://api.deepseek.com/chat/completions" : `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(isDeepseek ? { "Authorization": `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(isDeepseek ? {
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_object" }
    } : { contents: [{ parts: [{ text: systemPrompt + "\n" + userPrompt }] }] })
  });
  const data = await res.json();
  const text = isDeepseek ? data.choices?.[0]?.message?.content : data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid AI response: empty or non-string content');
  }
  return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
}

async function translateContent(content: any, targetLang: string, type: string) {
  const KEY = Deno.env.get("DEEPSEEK_API_KEY") || Deno.env.get("GEMINI_API_KEY");
  const isDeepseek = !!Deno.env.get("DEEPSEEK_API_KEY");

  const langNames: Record<string, string> = { en: "English", es: "Spanish (Español)", it: "Italian (Italiano)" };
  const fullLang = langNames[targetLang] || targetLang;

  const systemPrompt = `You are a professional translator specializing in spiritual and astrological texts.
CRITICAL REQUIREMENT: Translate ALL text values to ${fullLang}. Every single string value in the JSON must be in ${fullLang}.
Do NOT leave any text in English (unless it is a Sanskrit term or proper noun).
Maintain the exact JSON structure and keys (keys stay in English). Only translate text VALUES.
Preserve Sanskrit terminology (mantras, deity names, technical jyotish terms) but translate all descriptions, explanations, and prose to ${fullLang}.
Keep the spiritual and poetic tone. Return valid JSON only.`;

  const userPrompt = `Translate ALL text values in this ${type} JSON to ${fullLang}. Every description, title, explanation, and prose MUST be in ${fullLang}:\n${JSON.stringify(content, null, 2)}`;

  const res = await fetch(isDeepseek ? "https://api.deepseek.com/chat/completions" : `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(isDeepseek ? { "Authorization": `Bearer ${KEY}` } : {}) },
    body: JSON.stringify(isDeepseek ? {
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      response_format: { type: "json_object" }
    } : { contents: [{ parts: [{ text: systemPrompt + "\n" + userPrompt }] }] })
  });

  const data = await res.json();
  const text = isDeepseek ? data.choices?.[0]?.message?.content : data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('Invalid translation response: empty or non-string content');
  }
  return JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
}

//////////////////////////////////////////////////
// PDF GENERATION
//////////////////////////////////////////////////

// Sanitize text for PDF (remove Unicode characters that WinAnsi can't encode)
function sanitizeForPDF(text: any): string {
  if (!text) return '';
  if (typeof text !== 'string') {
    // Convert non-string values to string
    text = String(text);
  }
  return text
    // Replace arrows
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/↑/g, '^')
    .replace(/↓/g, 'v')
    // Replace common spiritual symbols
    .replace(/ॐ/g, 'OM')
    // Replace emojis and symbols
    .replace(/🙏/g, '(Namaste)')
    .replace(/📄/g, '[DOC]')
    .replace(/✨/g, '*')
    .replace(/🔮/g, '[Crystal]')
    .replace(/📍/g, '[Loc]')
    .replace(/📝/g, '[Note]')
    .replace(/🌐/g, '[Web]')
    .replace(/📖/g, '[Book]')
    // Replace smart quotes
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // Replace other common Unicode
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/…/g, '...')
    .replace(/©/g, '(C)')
    .replace(/®/g, '(R)')
    .replace(/™/g, '(TM)')
    // Keep characters that are supported by WinAnsi (includes common accents)
    // ASCII (0-127) and Latin-1 (128-255)
    .replace(/[^\x00-\xFF]/g, '');
}

async function generatePDF(data: ExportData): Promise<Uint8Array> {
  const { cast, structure, advice, lang, timestamp, chakraImage } = data;
  const t = getI18N(lang);

  // Create a new PDF document
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helveticaOblique = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // Define colors
  const goldColor = rgb(0.84, 0.58, 0.29);  // #d69449 (Temple Gold)
  const darkBrown = rgb(0.41, 0.23, 0.13);   // #693b22 (Sandalwood)
  const textColor = rgb(0.11, 0.09, 0.08);     // #1b1715 (Ink)
  const lightGray = rgb(0.68, 0.65, 0.64);      // #ada7a3 (Stone)
  const jadeColor = rgb(0.31, 0.46, 0.33);   // #4f7653 (Jade)

  let currentPage = pdfDoc.addPage([612, 792]); // Letter size
  let y = 750;
  const margin = 50;
  const pageWidth = 612;
  const contentWidth = pageWidth - (margin * 2);

  // Helper function to add wrapped text (with sanitization and pagination)
  // Handles newlines by treating them as paragraph breaks
  function addWrappedText(text: any, size: number, font: any, color: any, x: number, yPos: number, maxWidth: number): number {
    const sanitized = sanitizeForPDF(text);
    if (!sanitized) return yPos;

    // Split on newlines first to handle paragraphs
    const paragraphs = sanitized.split('\n');
    let currentY = yPos;

    for (let p = 0; p < paragraphs.length; p++) {
      const paragraph = paragraphs[p].trim();
      if (!paragraph) {
        // Empty paragraph = extra line break
        currentY -= size;
        continue;
      }

      const words = paragraph.split(' ');
      let line = '';

      for (const word of words) {
        const testLine = line + (line ? ' ' : '') + word;
        const width = font.widthOfTextAtSize(testLine, size);

        if (width > maxWidth && line) {
          // Check for bottom margin
          if (currentY < margin + size) {
            currentPage = pdfDoc.addPage([612, 792]);
            currentY = 750;
          }
          currentPage.drawText(line, { x, y: currentY, size, font, color });
          currentY -= size + 4;
          line = word;
        } else {
          line = testLine;
        }
      }

      if (line) {
        // Check for bottom margin
        if (currentY < margin + size) {
          currentPage = pdfDoc.addPage([612, 792]);
          currentY = 750;
        }
        currentPage.drawText(line, { x, y: currentY, size, font, color });
        currentY -= size + 4;
      }

      // Add extra spacing between paragraphs (except after last)
      if (p < paragraphs.length - 1) {
        currentY -= size;
      }
    }

    y = currentY; // Keep outer y in sync
    return currentY;
  }

  // Improved addText with wrapping and pagination
  function addText(text: any, size: number, font: any, color: any, x: number, yPos: number): number {
    return addWrappedText(text, size, font, color, x, yPos, pageWidth - margin - x);
  }

  // Helper function to check if we need a new page
  function checkNewPage(requiredSpace: number): void {
    if (y < requiredSpace + margin) {
      currentPage = pdfDoc.addPage([612, 792]);
      y = 750;
    }
  }

  // Title
  y = addText(t.exportTitle, 24, helveticaBold, jadeColor, margin, y);
  y -= 10;

  // Date and Language
  y = addText(`${t.date}: ${new Date(timestamp).toLocaleString()}`, 10, helvetica, lightGray, margin, y);
  y = addText(`${t.language}: ${lang.toUpperCase()}`, 10, helvetica, lightGray, margin, y);
  y -= 15;

  // Query Section
  y = addText(String(t.query).toUpperCase(), 14, helveticaBold, goldColor, margin, y);
  y -= 5;
  const queryText = typeof cast.question === 'string' ? cast.question : (cast.question ? String(cast.question) : t.generalReading);
  y = addWrappedText(`"${queryText}"`, 11, helveticaOblique, textColor, margin, y, contentWidth);
  y -= 20;

  // Technical Details Section
  checkNewPage(100);
  y = addText(String(t.technicalDetails).toUpperCase(), 14, helveticaBold, goldColor, margin, y);
  y -= 10;

  y = addText(`${t.shellDistribution}:`, 11, helveticaBold, textColor, margin, y);
  y = addText(`  ${t.upright}: ${cast.counts.total_up}`, 10, helvetica, textColor, margin + 10, y);
  y = addText(`  ${t.reversed}: ${cast.counts.total_dn}`, 10, helvetica, textColor, margin + 10, y);
  y = addText(`  ${t.arudha}: House ${cast.arudha}`, 10, helvetica, textColor, margin + 10, y);

  if (cast.janma_lagna) {
    y = addText(`  ${t.janmaLagna}: ${cast.janma_lagna.sign} (${cast.janma_lagna.degrees.toFixed(2)}°)`, 10, helvetica, textColor, margin + 10, y);
  }
  y -= 10;

  y = addText(`${t.timePiles}:`, 11, helveticaBold, textColor, margin, y);
  y = addText(`  ${t.past}: ${cast.time_piles.past} | ${t.present}: ${cast.time_piles.present} | ${t.future}: ${cast.time_piles.future}`, 10, helvetica, textColor, margin + 10, y);
  y -= 20;

  // Prasna Chakra - Shell Distribution
  checkNewPage(200);
  y = addText(String(t.prasnaChakra || 'Prasna Chakra').toUpperCase(), 14, helveticaBold, goldColor, margin, y);
  y -= 10;
  y = addText(t.kavanaVisualization || 'Kavana (Shell) Distribution', 11, helveticaBold, textColor, margin, y);
  y -= 5;

  // Calculate house shell counts
  const houseCounts: Array<{ house: number; up: number; down: number; total: number }> = [];
  for (let h = 1; h <= 12; h++) {
    const shells = cast.board[h] || [];
    const up = shells.filter((s: any) => s.up === "UP").length;
    const down = shells.filter((s: any) => s.up === "DN").length;
    houseCounts.push({ house: h, up, down, total: shells.length });
  }

  // Display houses in Northern style layout (2 rows of 6)
  y = addText((t.housesTop || 'Houses 7-12 (Top)') + ':', 9, helveticaBold, darkBrown, margin, y);
  y -= 3;
  let rowText = '';
  for (let i = 6; i < 12; i++) {
    const h = houseCounts[i];
    rowText += `H${h.house}:${t.upSymbol?.charAt(0) || 'U'}${h.up}/${t.downSymbol?.charAt(0) || 'D'}${h.down}  `;
  }
  y = addText(rowText, 8, helvetica, textColor, margin + 10, y);
  y -= 10;

  y = addText((t.housesBottom || 'Houses 1-6 (Bottom)') + ':', 9, helveticaBold, darkBrown, margin, y);
  y -= 3;
  rowText = '';
  for (let i = 0; i < 6; i++) {
    const h = houseCounts[i];
    rowText += `H${h.house}:${t.upSymbol?.charAt(0) || 'U'}${h.up}/${t.downSymbol?.charAt(0) || 'D'}${h.down}  `;
  }
  y = addText(rowText, 8, helvetica, textColor, margin + 10, y);
  y -= 15;

  // House breakdown table
  y = addText(`${t.houseLegend || 'House'} ${t.breakdown || 'Breakdown'}:`, 9, helveticaBold, darkBrown, margin, y);
  y -= 5;
  y = addText(`${t.house || 'House'}  ${t.total || 'Total'}  ${t.upright || 'Upright'}  ${t.reversed || 'Reversed'}  ${t.nature || 'Nature'}`, 8, helveticaBold, darkBrown, margin, y);
  y -= 3;
  houseCounts.forEach(h => {
    let nature;
    const isOddHouse = [1, 3, 5, 7, 9, 11].includes(h.house);
    const upRatio = h.total > 0 ? h.up / h.total : 0;

    // Apply auspiciousness rules
    if (isOddHouse) {
      if (upRatio >= 0.5) nature = t.benefic || 'Benefic';
      else if (upRatio < 0.4) nature = t.malefic || 'Malefic';
      else nature = t.neutral || 'Neutral';
    } else {
      if (upRatio < 0.5) nature = t.benefic || 'Benefic';
      else if (upRatio > 0.6) nature = t.malefic || 'Malefic';
      else nature = t.neutral || 'Neutral';
    }

    y = addText(`${String(h.house).padStart(2)}   ${String(h.total).padStart(2)}     ${String(h.up).padStart(2)}        ${String(h.down).padStart(2)}        ${nature}`, 8, helvetica, textColor, margin, y);
  });
  y -= 5;
  y = addText(`${t.shellLegend || 'Shells'}: ${t.upSymbol || 'U (Upright)'} = Benefic, ${t.downSymbol || 'D (Reversed)'} = Malefic`, 8, helveticaOblique, lightGray, margin, y);
  y -= 20;

  // Embed Chakra Visualization Image if available
  if (chakraImage) {
    checkNewPage(300);
    y = addText(String(t.chakraVisualization || 'Prasna Chakra Visualization').toUpperCase(), 12, helveticaBold, goldColor, margin, y);
    y -= 10;

    try {
      // Extract base64 data from data URL
      const base64Data = chakraImage.split(',')[1];
      if (base64Data) {
        const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        const embeddedImage = await pdfDoc.embedPng(imageBytes);

        // Calculate image dimensions (max width 500px, maintain aspect ratio)
        const maxWidth = 500;
        const imgWidth = embeddedImage.width;
        const imgHeight = embeddedImage.height;
        const scale = Math.min(maxWidth / imgWidth, 1);
        const finalWidth = imgWidth * scale;
        const finalHeight = imgHeight * scale;

        // Center the image on the page
        const x = (pageWidth - finalWidth) / 2;

        // Check if we need a new page for the image
        if (y - finalHeight < margin) {
          currentPage = pdfDoc.addPage([612, 792]);
          y = 750;
        }

        currentPage.drawImage(embeddedImage, {
          x: x,
          y: y - finalHeight,
          width: finalWidth,
          height: finalHeight,
        });

        y -= finalHeight + 20;
      }
    } catch (imgError) {
      console.error('Error embedding chakra image:', imgError);
      y = addText('(Chakra visualization could not be embedded)', 9, helveticaOblique, lightGray, margin, y);
      y -= 20;
    }
  }

  // Planetary Positions
  if (cast.transit_planets && Object.keys(cast.transit_planets).length > 0) {
    checkNewPage(100);
    y = addText(String(t.planetaryPositions).toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;

    y = addText(`${String(t.planet).padEnd(12)} ${String(t.house).padEnd(8)} ${String(t.degrees)}`, 10, helveticaBold, darkBrown, margin, y);
    y -= 5;

    Object.entries(cast.transit_planets).forEach(([planet, data]: [string, any]) => {
      y = addText(`${planet.padEnd(12)} ${String(data.house).padEnd(8)} ${data.degrees.toFixed(2)}°`, 9, helvetica, textColor, margin, y);
    });
    y -= 20;
  }

  // Structure Analysis Section
  checkNewPage(100);
  y = addText(String(structure.analysis_title || t.celestialStructure).toUpperCase(), 16, helveticaBold, darkBrown, margin, y);
  y -= 15;

  structure.sections?.forEach((section: any, index: number) => {
    checkNewPage(150);
    y = addText(`${index + 1}. ${section.title || 'Section ' + (index + 1)}`, 13, helveticaBold, goldColor, margin, y);
    y -= 8;

    // Technical perspective
    const technicalText = String(section.technical_rishi || section.technical || '');
    if (technicalText.trim().length > 0) {
      y = addText(t.technicalPerspective + ':', 10, helveticaBold, darkBrown, margin, y);
      y = addWrappedText(technicalText, 9, helvetica, textColor, margin + 10, y, contentWidth - 20);
      y -= 8;
    }

    // Modern interpretation
    const modernText = String(section.colloquial_modern || section.colloquial || '');
    if (modernText.trim().length > 0) {
      y = addText(t.modernInterpretation + ':', 10, helveticaBold, darkBrown, margin, y);
      y = addWrappedText(modernText, 9, helvetica, textColor, margin + 10, y, contentWidth - 20);
      y -= 20;
    }
  });

  // Concluding insight
  if (structure.concluding_insight) {
    checkNewPage(100);
    y = addText(String(t.concludingInsight).toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;
    y = addWrappedText(String(structure.concluding_insight), 10, helveticaOblique, darkBrown, margin, y, contentWidth);
    y -= 20;
  }

  // Spiritual Guidance Section
  const guidance = advice.spiritual_guidance || advice;
  
  // Blessing Section (if counsel_title exists)
  if (guidance.counsel_title) {
    checkNewPage(100);
    y = addText(String(t.blessingTitle || 'Blessing of Light and Overcoming').toUpperCase(), 16, helveticaBold, goldColor, margin, y);
    y -= 10;
    y = addWrappedText(`"${String(guidance.counsel_title)}"`, 12, helveticaOblique, goldColor, margin, y, contentWidth);
    y -= 20;
  }
  
  checkNewPage(100);
  y = addText(String(t.spiritualGuidance || 'Spiritual Guidance').toUpperCase(), 16, helveticaBold, darkBrown, margin, y);
  y -= 15;

  // Handle narrative - ensure it's always an array
  let narrative = guidance.guidance_narrative || guidance.narrative_sections || [];
  if (!Array.isArray(narrative)) {
    if (typeof narrative === 'string' && narrative.trim()) {
      narrative = [{ heading: t.sacredGuidance || 'Sacred Guidance', content: narrative }];
    } else if (typeof narrative === 'object' && narrative !== null) {
      narrative = Object.entries(narrative).map(([key, value]) => ({
        heading: key,
        content: typeof value === 'string' ? value : JSON.stringify(value)
      }));
    } else {
      narrative = [];
    }
  }
  narrative.forEach((item: any, index: number) => {
    if (!item) return;
    const content = item.content || item.body || '';
    if (typeof content !== 'string' || content.trim().length === 0) return; // Skip empty items
    
    checkNewPage(150);
    y = addText(`${index + 1}. ${item.heading || item.title || 'Guidance'}`, 13, helveticaBold, goldColor, margin, y);
    y -= 8;

    // Content
    y = addWrappedText(content, 9, helvetica, textColor, margin, y, contentWidth);
    y -= 20;
  });

  // Remedies - Enhanced format with mantra, visual reference, tantra reference
  let remedies = guidance.specific_remedies || [];
  if (!Array.isArray(remedies)) {
    remedies = [];
  }
  if (remedies.length > 0) {
    checkNewPage(100);
    y = addText(String(t.sacredRemedies).toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 10;

    remedies.forEach((remedy: any, index: number) => {
      checkNewPage(150);

      // Title and Type
      const typeLabel = remedy.type ? `[${String(remedy.type).toUpperCase()}] ` : '';
      y = addText(`${index + 1}. ${typeLabel}${sanitizeForPDF(remedy.title || remedy.name || '')}`, 11, helveticaBold, darkBrown, margin, y);
      y -= 5;

      // Sanskrit name
      if (remedy.sanskrit_name) {
        y = addText(`   ${sanitizeForPDF(remedy.sanskrit_name)}`, 9, helveticaOblique, goldColor, margin, y);
        y -= 5;
      }

      // Mantra (sanskrit + transliteration + translation)
      if (remedy.mantra) {
        y -= 5;
        y = addText('   Mantra:', 9, helveticaBold, darkBrown, margin + 10, y);
        if (remedy.mantra.sanskrit) {
          y = addText(`   ${sanitizeForPDF(remedy.mantra.sanskrit)}`, 9, helvetica, textColor, margin + 10, y);
        }
        if (remedy.mantra.transliteration) {
          y = addText(`   ${sanitizeForPDF(remedy.mantra.transliteration)}`, 8, helveticaOblique, lightGray, margin + 10, y);
        }
        if (remedy.mantra.translation) {
          y = addText(`   "${sanitizeForPDF(remedy.mantra.translation)}"`, 8, helveticaOblique, lightGray, margin + 10, y);
        }
        y -= 5;
      }

      // Visual reference and drawing instructions
      if (remedy.visual_reference || remedy.drawing_instructions) {
        y -= 3;
        if (remedy.visual_reference) {
          y = addText(`   Visual: ${sanitizeForPDF(remedy.visual_reference)}`, 8, helveticaOblique, lightGray, margin + 10, y);
        }
        if (remedy.drawing_instructions) {
          y = addWrappedText(`   Instructions: ${sanitizeForPDF(remedy.drawing_instructions)}`, 8, helveticaOblique, lightGray, margin + 10, y, contentWidth - 20);
        }
      }

      // Procedure
      if (remedy.procedure) {
        y -= 3;
        y = addWrappedText(`   Procedure: ${sanitizeForPDF(remedy.procedure)}`, 9, helvetica, textColor, margin + 10, y, contentWidth - 20);
      }

      // Duration
      if (remedy.duration) {
        y = addText(`   Duration: ${sanitizeForPDF(remedy.duration)}`, 8, helveticaOblique, lightGray, margin + 10, y);
      }

      // Materials with Sanskrit and local names
      if (remedy.materials && remedy.materials.length > 0) {
        y -= 3;
        const matStr = remedy.materials.map((m: any) => {
          if (typeof m === 'string') return m;
          return m.display || `${m.local || ''} (${m.sanskrit || ''})`;
        }).join(', ');
        y = addWrappedText(`   Materials: ${sanitizeForPDF(matStr)}`, 8, helveticaOblique, lightGray, margin + 10, y, contentWidth - 20);
      }

      // Tantra reference
      if (remedy.tantra_reference) {
        y -= 3;
        y = addWrappedText(`   Tantra: ${sanitizeForPDF(remedy.tantra_reference)}`, 8, helveticaOblique, goldColor, margin + 10, y, contentWidth - 20);
      }

      // Scriptural source
      if (remedy.scriptural_source) {
        y -= 3;
        y = addText(`   Source: ${sanitizeForPDF(remedy.scriptural_source)}`, 8, helveticaOblique, lightGray, margin + 10, y);
      }

      // Expected outcome
      if (remedy.expected_outcome) {
        y -= 3;
        y = addWrappedText(`   Expected: ${sanitizeForPDF(remedy.expected_outcome)}`, 9, helveticaBold, jadeColor, margin + 10, y, contentWidth - 20);
      }

      y -= 15;
    });
  }

  // Final Prediction
  if (guidance.final_prediction) {
    checkNewPage(100);
    y = addText(String(t.finalPrediction).toUpperCase(), 14, helveticaBold, goldColor, margin, y);
    y -= 5;
    // Handle both string and object formats
    let predictionText;
    if (typeof guidance.final_prediction === 'string') {
      predictionText = guidance.final_prediction;
    } else if (typeof guidance.final_prediction === 'object') {
      const fp = guidance.final_prediction;
      const parts = [];
      if (fp.timing) parts.push(`Timing: ${fp.timing}`);
      if (fp.result) parts.push(`Result: ${fp.result}`);
      if (fp.certainty) parts.push(`Certainty: ${fp.certainty}`);
      if (fp.conditions && Array.isArray(fp.conditions) && fp.conditions.length > 0) {
        parts.push(`Conditions: ${fp.conditions.join(', ')}`);
      }
      predictionText = parts.length > 0 ? parts.join('\n') : JSON.stringify(fp);
    } else {
      predictionText = String(guidance.final_prediction);
    }
    y = addWrappedText(predictionText, 11, helveticaBold, darkBrown, margin, y, contentWidth);
    y -= 30;
  }

  // Rishi Counsel Note (always at the end, before footer)
  checkNewPage(100);
  y = addText(String(t.seekRishiCounsel || 'For deeper guidance in this matter, seek the counsel of a qualified Rishi.'), 10, helveticaOblique, goldColor, margin, y);
  y -= 30;

  // Footer on last page
  checkNewPage(50);
  y -= 20;
  y = addText(String(t.generatedBy), 8, helveticaOblique, lightGray, margin, y);
  y = addText(String(t.sacredWisdom), 9, helveticaOblique, goldColor, margin, y);

  // Generate PDF bytes
  return await pdfDoc.save();
}

//////////////////////////////////////////////////
// HTTP ROUTER
//////////////////////////////////////////////////

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const lang = body.lang || "en";

    if (url.pathname.includes("/cast")) {
      return new Response(JSON.stringify(await simulateCast(body.bits, body.q, body.lang, body.birth, body.prasna)), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname.includes("/translate")) {
      const { content, targetLang, type } = body;
      const translated = await translateContent(content, targetLang, type);
      return new Response(JSON.stringify(translated), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ========================================================
    // TECHNICAL ANALYSIS (deterministic, no AI) — fast ~50ms
    // ========================================================
    if (url.pathname.includes("/interpret/technical")) {
      const { kavane, planets, lagnas, boundaries, meta, natal_chart } = body;

      // --- Shell Summary ---
      const kArr = kavane || [];
      const total_up = kArr.filter((k: any) => k.up).length;
      const total_down = kArr.length - total_up;
      const up_ratio = kArr.length > 0 ? +(total_up / kArr.length).toFixed(3) : 0;

      // --- House Analysis ---
      const rashiNames = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Thula", "Vrischika", "Dhanus", "Makara", "Kumbha", "Meena"];
      const houseData: Record<number, { h: number; s: string; n: number; u: number; d: number }> = {};
      for (let h = 1; h <= 12; h++) houseData[h] = { h, s: rashiNames[h - 1], n: 0, u: 0, d: 0 };
      kArr.forEach((k: any) => {
        const h = k.house;
        if (h >= 1 && h <= 12) {
          houseData[h].n++;
          if (k.up) houseData[h].u++; else houseData[h].d++;
        }
      });
      const houses = Object.values(houseData).map(d => ({
        ...d,
        ratio: d.n > 0 ? +(d.u / d.n).toFixed(2) : 0,
        pct: kArr.length > 0 ? +(d.n / kArr.length * 100).toFixed(1) : 0
      }));
      const dominant = [...houses].sort((a, b) => b.n - a.n).slice(0, 3).map(h => h.h);
      const weak = [...houses].sort((a, b) => a.n - b.n).slice(0, 3).map(h => h.h);

      // --- Lagna Synthesis ---
      // Handle both object format {house: N} and direct number format N
      const swarnaData = lagnas?.swarna;
      const udayaData = lagnas?.udaya;

      // Support both {house: N} object format and direct number
      const sH = typeof swarnaData === 'number' ? swarnaData : (swarnaData?.house || 0);
      const uH = typeof udayaData === 'number' ? udayaData : (udayaData?.house || 0);

      const hasSwarna = sH > 0 && sH <= 12;
      const hasUdaya = uH > 0 && uH <= 12;

      const diff = Math.abs(sH - uH);
      const angDist = Math.min(diff, 12 - diff);

      let tulya_type = "unknown";
      if (!hasSwarna && !hasUdaya) {
        tulya_type = "incomplete";
      } else if (!hasSwarna || !hasUdaya) {
        tulya_type = "partial";  // Only one lagna available
      } else if (angDist === 0) {
        tulya_type = "sama";       // same house — Tulya Lagna
      } else if (angDist === 1) {
        tulya_type = "adjacent";
      } else if (angDist === 6) {
        tulya_type = "opposite";    // Atulya
      } else if ([4, 8].includes(angDist)) {
        tulya_type = "trine";
      } else if ([3, 9].includes(angDist)) {
        tulya_type = "kendra";
      } else {
        tulya_type = "other";
      }

      const lagna_synthesis = {
        sH: hasSwarna ? sH : null,
        uH: hasUdaya ? uH : null,
        angDist: hasSwarna && hasUdaya ? angDist : null,
        tulya_type,
        has_swarna: hasSwarna,
        has_udaya: hasUdaya
      };

      // --- Planetary Highlights ---
      const digBalaHouse: Record<string, number> = { Sun: 10, Mars: 10, Jupiter: 1, Mercury: 1, Moon: 4, Venus: 4, Saturn: 7 };
      const benefics = ["Jupiter", "Venus", "Mercury", "Moon"];
      const malefics = ["Sun", "Mars", "Saturn", "Rahu", "Ketu"];
      const planetHighlights = Object.entries(planets || {}).map(([name, d]: [string, any]) => {
        const hasDig = digBalaHouse[name] === d.house;
        return {
          p: name,
          h: d.house,
          s: d.sign || "",
          deg: +(d.degrees || 0).toFixed(1),
          st: d.state || "neutral",
          ret: !!d.retrograde,
          nat: benefics.includes(name) ? "B" : malefics.includes(name) ? "M" : "N",
          dig: hasDig
        };
      });

      // --- Pile Interpretation ---
      const pileMeanings: Record<number, { nm: string; sym: string; mn: string }> = {
        1: { nm: "Shasha", sym: "rabbit", mn: "timidity, hesitation, need for caution" },
        2: { nm: "Vishanika", sym: "thorn", mn: "obstacles, pain, difficulties ahead" },
        3: { nm: "Kaka", sym: "crow", mn: "deception, illusion, mixed results" },
        4: { nm: "Kukkuta", sym: "rooster", mn: "pride, confidence, favorable timing" },
        5: { nm: "Swati", sym: "sword", mn: "decisive action, cutting through obstacles" },
        6: { nm: "Vinayaka", sym: "elephant", mn: "auspicious, removal of obstacles, Ganesha's grace" },
        7: { nm: "Naga", sym: "serpent", mn: "kundalini energy, hidden power, transformation" },
        8: { nm: "Chakra", sym: "discus", mn: "divine protection, completion, Vishnu's grace" }
      };
      const piles = boundaries?.piles || {};
      const pile_interp = {
        past: piles.past ? { v: piles.past, ...(pileMeanings[piles.past] || {}) } : null,
        present: piles.present ? { v: piles.present, ...(pileMeanings[piles.present] || {}) } : null,
        future: piles.future ? { v: piles.future, ...(pileMeanings[piles.future] || {}) } : null
      };

      // --- Drishti (Aspects) from pile planets ---
      const pile_drishti = boundaries?.pile_drishti || null;

      // --- Drishti from transit planets (if available) ---
      const transit_drishti: Record<string, { house: number; aspects: number[] }> = {};
      Object.entries(planets || {}).forEach(([name, d]: [string, any]) => {
        if (d.aspects && Array.isArray(d.aspects)) {
          transit_drishti[name] = { house: d.house, aspects: d.aspects };
        }
      });

      // --- Kavane by Sign (for Southern view) ---
      const bySign: Record<string, number> = {};
      kArr.forEach((k: any) => { bySign[k.sign] = (bySign[k.sign] || 0) + 1; });

      const technical = {
        shell_summary: { total_up, total_down, up_ratio, total: kArr.length },
        houses,
        dominant,
        weak,
        lagna_synthesis,
        planets: planetHighlights,
        piles: pile_interp,
        pile_drishti,
        transit_drishti: Object.keys(transit_drishti).length > 0 ? transit_drishti : null,
        by_sign: bySign,
        natal_chart: natal_chart || null,
        meta: {
          ts: meta?.timestamp || new Date().toISOString(),
          seed: meta?.seedFingerprint?.substring(0, 8) || "",
          src: meta?.beaconSources || [],
          lang: lang || "en",
          has_natal_chart: !!natal_chart
        }
      };

      return new Response(JSON.stringify({ success: true, technical }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // ========================================================
    // NARRATIVE INTERPRETATION (AI-powered, lightweight prompt)
    // ========================================================
    if (url.pathname.includes("/interpret/narrative")) {
      const { query, technical, history } = body;
      const requestLang = body.lang || lang;

      let historyStr = "";
      if (history && history.length > 0) {
        historyStr = "\n--- SESSION MEMORY ---\n" +
          history.slice(-3).map((h: any) => `Q: ${h.question || "N/A"} | ${h.time_ago}`).join("\n") + "\n";
      }

      const fullLang = getFullLangName(requestLang);
      const narrativeSystem = `You are a practitioner of Vedic wisdom, expert in Ashtamangala Deva Prasna. Return minified JSON.

CRITICAL: Respond ENTIRELY in ${fullLang}. ALL text values, titles, descriptions, and prose MUST be written in ${fullLang}. Do NOT leave any text in English unless it is a Sanskrit term or proper noun.

You receive PRE-COMPUTED technical data. Do NOT recount shells or recompute statistics. Focus ONLY on Vedic interpretation and narrative wisdom.

CITE ONLY these traditional sources:
- Brihat Parashara Hora Shastra (BPHS)
- Phala Deepika (Mantreswara)
- Saravali (Kalyana Varma)
- Brihat Jataka (Varahamihira)
- Prasna Marga (Harihara)
- Narada Samhita

PILE NAMES (keep in Sanskrit, do not translate): 1=Shasha 2=Vishanika 3=Kaka 4=Kukkuta 5=Swati 6=Vinayaka 7=Naga 8=Chakra

REQUIRED SECTION FORMAT - Each section MUST have:
- title: descriptive name of the analysis area
- technical_rishi: Vedic technical analysis with Sanskrit terminology (MANDATORY - never empty)
- vedic_citations: array of scripture references
- colloquial_modern: accessible modern explanation

JSON SCHEMA (minified):
{"analysis_title":"str","sections":[{"title":"str","technical_rishi":"str - MANDATORY Vedic technical analysis with specific verses, Sanskrit terms, NEVER empty","vedic_citations":["BPHS Ch.X"],"colloquial_modern":"str - accessible modern explanation"}],"concluding_insight":"str"}

Generate exactly these 6 sections in this order:

SECTION 1: "Six Lagnas, Hora Shastra (Natal) Lagna, and Kavana Synthesis"
MANDATORY - USE EXACT DATA FROM INPUT:
- Swarna Aroodham: Use technical.lagna_synthesis.sH (house) and technical.lagna_synthesis.tulya_type
- Udaya Lagna: Use technical.lagna_synthesis.uH (house)
- Hora Shastra Lagna (Natal Chart): IF technical.natal_chart EXISTS, analyze natal lagna and natal planet positions
- CRITICAL: Report the ACTUAL relationship: if tulya_type is "sama" they are same house, if "different" or other value they are NOT the same
- Angular distance: technical.lagna_synthesis.angDist (if available)
- Integrate shell distribution (Up vs Down) with lagna positions
- Reference odd/even pile significance

NATAL CHART ANALYSIS (if technical.natal_chart provided):
- Analyze natal lagna (birth ascendant) and its relationship to Swarna/Udaya
- Compare natal planet positions with transit (prasna) planets
- Identify which natal houses are activated by current prasna
- Use Lahiri ayanamsa for natal calculations

DO NOT say "same position" or "sama" unless tulya_type is ACTUALLY "sama". If houses are different, explicitly state they are in different houses and interpret that meaning.

SECTION 2: "Kavana Distribution Analysis"
- Quantitative analysis of Up vs Down shells
- Odd houses (1,3,5,7,9,11) vs Even houses (2,4,6,8,10,12) distribution
- Auspicious vs inauspicious ratios based on pile counts
- Shell clustering patterns and their meanings

SECTION 3: "House Analysis"
- Dominant houses (highest shell counts)
- Weak houses (lowest shell counts)
- Planetary placements in key houses
- Dig Bala considerations

SECTION 4: "Drishti (Aspects) Analysis"
- MANDATORY section - must include "Drishti" or "Aspects" in title
- Transit planet aspects (primary)
- Pile-based aspects (secondary)
- Benefic vs malefic aspect influences

SECTION 5: "Temporal Pile Interpretation"
- Past pile meaning (Sanskrit name)
- Present pile meaning (Sanskrit name)
- Future pile meaning (Sanskrit name)
- Time-based progression analysis

SECTION 6: "Query-Specific Insight"
- Tailored interpretation addressing the specific question
- Integration of all previous analyses for the query context

CONCLUDING REMARK: End with advice to "seek the counsel of a qualified Rishi for deeper guidance in this matter."

TECHNICAL CONTENT REQUIREMENTS:
Each technical_rishi field MUST:
1. Be substantive (minimum 2-3 sentences)
2. Include specific Sanskrit technical terms
3. Reference at least one scriptural source
4. NEVER be empty or placeholder text`;

      const narrativeUser = `Question: "${query || 'General reading'}" Technical Summary: ${JSON.stringify(technical)}${historyStr}`;

      const narrative = await callAI(narrativeSystem, narrativeUser);
      
      // Validate and sanitize sections - ensure technical_rishi field exists and has content
      if (narrative.sections && Array.isArray(narrative.sections)) {
        narrative.sections = narrative.sections
          .map((s: any) => {
            // Normalize field names
            const tech = String(s.technical_rishi || s.technical_analysis || s.technical || '');
            return {
              ...s,
              technical_rishi: tech.trim()
            };
          })
          .filter((s: any) => {
            // Keep sections that have either technical content or substantial colloquial content
            const hasTech = s.technical_rishi && s.technical_rishi.length > 10;
            const hasColloquial = String(s.colloquial_modern || s.colloquial || '').length > 20;
            return hasTech || hasColloquial;
          });
      } else {
        narrative.sections = [];
      }
      
      // Ensure lang is included in response meta
      if (!narrative.meta) narrative.meta = {};
      narrative.meta.lang = requestLang;
      return new Response(JSON.stringify({ success: true, narrative }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // STRUCTURE/TECHNICAL ANALYSIS endpoint (LEGACY — kept for backward compatibility)
    if (url.pathname.includes("/interpret/structure")) {
      const { query, meta, lagnas, planets, kavane, boundaries, history, natal_chart } = body;
      const requestLang = body.lang || lang;

      let historyStr = "";
      if (history && history.length > 0) {
        historyStr = "\n--- SESSION MEMORY (RECENT INQUIRIES) ---\n" +
          history.map((h: any) => `
      TIME: ${ h.time_ago }
      QUERY: ${ h.question || h.cast?.question || "N/A" }
TECHNICAL ANALYSIS GIVEN: ${ h.technical_summary || "N/A" }
FINAL PREDICTION GIVEN: ${ h.spiritual_prediction || "N/A" }
      ------------------------------------------`).join("\n") + "\n";
      }

      // Structured data schema for Rishi interpretation
      const fullLangStruct = getFullLangName(requestLang);
      const structureSystem = `You are a practitioner of Vedic Jyotisha, technical expert in Ashtamangala Prasna.
You MUST return minified JSON.

        CRITICAL: Respond ENTIRELY in ${ fullLangStruct }. ALL text values, titles, descriptions, and prose MUST be written in ${ fullLangStruct }. Do NOT leave any text in English unless it is a Sanskrit term or proper noun.

INPUT DATA FORMAT:
      {
        "meta": { "timestamp": "ISO", "beaconSources": ["nist" | "curby"], "seedFingerprint": "hex" },
        "lagnas": { "swarna": { "house": 1 - 12, "sign": "Aries", "degrees": 0 - 30, "nakshatra": "Ashwini" }, "udaya": {...} },
  "planets": { "Sun": { "house": 1 - 12, "sign": "...", "degrees": 0 - 30, "state": "exalted" | "debilitated" | "moolatrikona" | "own" | "friendly" | "enemy" | "neutral", "aspects": [1 - 12] }, "Moon": { ...}, ... },
  "kavane": [{ "x": 0 - 72, "y": 0 - 72, "house": 1 - 12, "sign": "...", "up": true | false }],
  "boundaries": {
  "piles": { "past": 1 - 8, "present": 1 - 8, "future": 1 - 8 },
  "pile_drishti": { "pile_aspects": { "Naga": { "house": 7, "aspects": [1, 5, 9] }, ... }, "analysis": "..." },
  "curves": { ...}
}
}

  TRADITIONAL VEDIC REFERENCES(cite these, not modern psychology):
  - Brihat Parashara Hora Shastra(BPHS)
- Phala Deepika by Mantreswara
- Saravali by Kalyana Varma
- Brihat Jataka by Varahamihira
- Deva Prasna by Shyamasundaradasa
- Prasna Marga by Harihara
- Narada Samhita
- Muhurta Chintamani

ANALYSIS REQUIREMENTS:
  1. Six Lagnas, Hora Shastra & Kavana Integration:
  - Analyze Swarna Aroodham, Udaya Lagna, Navamsa, Chatra, Sprishtanga, Chandra Lagna
  - IF natal_chart PROVIDED: Analyze Hora Shastra Lagna (natal ascendant) and natal planet positions
  - Compare natal vs transit (prasna) planet positions
  - Include shell distribution(Up vs Down) supporting each lagna
  - Odd vs even pile analysis(1, 3, 5, 7 = Good; 2, 4, 6, 8 = Bad)
  - Tulya / Atulya relationship between Swarna and Udaya
2. House Analysis: Dominant / weak houses, planetary placements, Dig Bala
3. Drishti(Aspects) Analysis - MANDATORY SECTION:
- MUST include "Drishti" or "Aspects" in the section title
  - Analyze which planets aspect which houses
    - Distinguish benefic(Jupiter, Venus) vs malefic(Saturn, Mars, Rahu) aspects
      - Include both transit planets(primary), natal planets (if provided), and pile planets(secondary)
4. Temporal Piles: Past / Present / Future pile meanings with planet associations
5. Query - Specific: Tailored interpretation based on the question asked
6. Natal Chart Integration (if provided): How birth chart influences current prasna reading

PILE NAMES(use these Sanskrit names in ALL languages, do not translate):
1 = Shasha(rabbit)  2 = Vishanika(thorn)  3 = Kaka(crow)  4 = Kukkuta(rooster)
5 = Swati(sword)    6 = Vinayaka(elephant)  7 = Naga(serpent)  8 = Chakra(discus)

JSON OUTPUT SCHEMA(minified):
{
  "analysis_title": "string - evocative Vedic title",
    "meta": { "timestamp": "ISO", "query_hash": "sha256 of query", "seed_short": "first8chars" },
  "technical": {
    "shell_summary": { "total_up": 0 - 108, "total_down": 0 - 108, "up_ratio": "0.00-1.00" },
    "house_analysis": [{ "house": 1 - 12, "shells": 0 - 108, "up": 0 - 108, "significance": "string" }],
      "lagna_synthesis": { "tulya_type": "same|adjacent|opposite", "relationship": "string" },
    "planetary_highlights": [{ "planet": "string", "significance": "string" }],
      "pile_interpretation": { "past": "meaning", "present": "meaning", "future": "meaning" }
  },
  "sections": [
    {
      "title": "string - house/planet/topic name",
      "technical_analysis": "string - precise Vedic analysis with specific verse references where known",
      "vedic_citations": ["BPHS Chapter X Verse Y", "Phala Deepika..."],
      "colloquial_modern": "string - accessible explanation"
    }
  ],
    "concluding_insight": "string - synthesizing technical observations"
} `;

      const structureUser = `Analyze Ashtamangala Prasna:
Question: "${query}"
Query Time: ${ meta?.timestamp || 'unknown' }
Seed: ${ meta?.seedFingerprint?.substring(0, 16) || 'unknown' }...
Beacon Sources: ${ meta?.beaconSources?.join(', ') || 'unknown' }

Structured Data: ${ JSON.stringify({ meta, lagnas, planets, kavane, boundaries }) }${ historyStr } `;

      const structure = await callAI(structureSystem, structureUser);
      
      // Validate and sanitize sections - ensure technical_rishi field exists and has content
      if (structure.sections && Array.isArray(structure.sections)) {
        structure.sections = structure.sections
          .map((s: any) => {
            // Normalize field names - accept technical_analysis as fallback
            const tech = String(s.technical_rishi || s.technical_analysis || s.technical || '');
            return {
              ...s,
              technical_rishi: tech.trim()
            };
          })
          .filter((s: any) => {
            // Keep sections that have either technical content or substantial colloquial content
            const hasTech = s.technical_rishi && s.technical_rishi.length > 10;
            const hasColloquial = String(s.colloquial_modern || s.colloquial || '').length > 20;
            return hasTech || hasColloquial;
          });
      } else {
        structure.sections = [];
      }
      
      // Ensure lang is included in response meta
      if (!structure.meta) structure.meta = {};
      structure.meta.lang = requestLang;
      return new Response(JSON.stringify({ success: true, structure }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // QUICK ADVICE endpoint - Fast spiritual guidance (~2-3s)
    if (url.pathname.includes("/interpret/advice/quick")) {
      const { query, structure, meta, history } = body;
      const requestLang = body.lang || lang;

      let historyStr = "";
      if (history && history.length > 0) {
        historyStr = "\n--- SESSION MEMORY ---\n" + history.slice(-2).map((h: any) => `Q: ${ h.question } `).join("\n") + "\n";
      }

      const fullLang = getFullLangName(requestLang);
      const quickSystem = `You are a practitioner of Vedic wisdom giving spiritual guidance.Return minified JSON.
  CRITICAL: Respond ENTIRELY in ${ fullLang }.

Provide BRIEF guidance:
1. counsel_title - blessing
2. guidance_narrative - 2 - 3 short paragraphs with key insights.Include advice to seek counsel from a qualified Rishi for deeper guidance.
3. key_remedies - 2 - 3 simple spiritual practices(mantra / puja / dana) with minimal detail.REMEDIES DISCLAIMER: These are spiritual activities and materials for alleviation, not medical advice.Consult professionals for health concerns.
4. final_prediction - timing and outcome

Keep it concise for fast response.`;

      const quickUser = `Question: "${query}"
Technical: ${ JSON.stringify(structure).substring(0, 2000) }${ historyStr } `;

      const advice = await callAI(quickSystem, quickUser);
      return new Response(JSON.stringify({ success: true, advice: { ...advice, meta: { lang: requestLang } } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // DETAILED REMEDIES endpoint - Full remedies with materials, mantras (~5-8s)
    if (url.pathname.includes("/interpret/advice/remedies")) {
      const { query, structure, meta, history, quickAdvice } = body;
      const requestLang = body.lang || lang;

      let historyStr = "";
      if (history && history.length > 0) {
        historyStr = "\n--- SESSION MEMORY ---\n" + history.map((h: any) => `Q: ${ h.question } `).join("\n") + "\n";
      }

      const fullLang = getFullLangName(requestLang);
      const remediesSystem = `You are a practitioner of Vedic wisdom, grounded in the Guru parampara(Parashara → Jaimini → Shyamasundara).
You MUST return minified JSON.

  CRITICAL: Respond ENTIRELY in ${ fullLang }. ALL text values MUST be in ${ fullLang }. Do NOT leave any text in English unless it is a Sanskrit mantra, deity name, or technical jyotish term.

LOCALIZATION REQUIREMENTS:
1. GEOLOCATION: Convert coordinates to place names(city, province / state, country) for map searches
2. MATERIALS: For each material, provide:
- Sanskrit name(always displayed)
  - Local name in ${ fullLang } (for map search: "store near [city] selling [local name]")
- Example: { "sanskrit": "Aksata", "local_search": "unpolished rice", "display": "Unpolished Rice (Aksata)" }
3. MANTRAS: ALWAYS include BOTH:
- Sanskrit text in Devanagari
  - Transliteration / pronunciation in ${ fullLang }
- Meaning / translation in ${ fullLang }
4. VISUAL REFERENCES: For yantras and rituals, describe:
- Drawing instructions(geometric patterns)
  - Colors / materials to use
    - Image reference: "[Yantra Name] - [simple description for image search]"
5. TANTRA REFERENCES: Quote specific verses from:
- Prapanchasara Tantra
  - Mahanirvana Tantra
    - Meru Tantra
Format: "Tantra Name, Chapter X, Verse Y: '[Sanskrit quote]' - [translation]"

AUTHENTIC VEDIC REMEDIES:
1. Mantra - Sanskrit with meter, devata, viniyoga
2. Yantra - Geometric patterns with drawing instructions
3. Puja / Homam - Dravya, mudra, nyasa
4. Dana - Items and recipients
5. Vrata - Katha and procedure
6. Ratna - Only if truly indicated
7. Aushadhi - Ayurvedic if health - related

REMEDIES DISCLAIMER(MUST INCLUDE):
"Remedies refer to spiritual activities (mantra, puja, dana, etc.) and traditional materials that may help alleviate the situation. They are NOT medical advice, diagnosis, or treatment. For health concerns, consult qualified medical professionals. For significant life decisions, seek the counsel of a qualified Rishi or spiritual guide."

CONSIDER DRISHTI: Use structure.technical.pile_drishti and transit_drishti

IMPORTANT: Conclude guidance with advice to "seek the counsel of a qualified Rishi for deeper guidance in this matter."

JSON SCHEMA:
{
  "counsel_title": "string",
    "guidance_narrative": [{ "heading": "string", "content": "string", "vedic_basis": "string" }],
      "specific_remedies": [{
        "type": "mantra|yantra|puja|dana|vrata|ratna|aushadhi",
        "title": "string",
        "sanskrit_name": "string - always displayed",
        "local_search_terms": { "materials_local": ["string"], "location": "city, province, country" },
        "mantra": {
          "sanskrit": "Devanagari text",
          "transliteration": "pronunciation guide",
          "translation": "meaning in ${fullLang}"
        },
        "visual_reference": "description for yantra/ritual image search",
        "drawing_instructions": "step-by-step for yantras",
        "procedure": "string",
        "duration": "string",
        "materials": [{ "sanskrit": "string", "local": "string", "display": "string" }],
        "tantra_reference": "Tantra Name, Chapter X: 'Sanskrit' - translation",
        "expected_outcome": "string"
      }],
        "final_prediction": { "timing": "string", "result": "string", "certainty": "certain|probable|possible|uncertain", "conditions": ["string"] }
} `;

      const remediesUser = `Question: "${query}"
Query Time: ${ meta?.timestamp || 'unknown' }
${ quickAdvice ? `Quick Advice Summary: ${JSON.stringify(quickAdvice)}` : '' }
Technical Analysis: ${ JSON.stringify(structure) }${ historyStr } `;

      const advice = await callAI(remediesSystem, remediesUser);
      return new Response(JSON.stringify({ success: true, advice: { ...advice, meta: { lang: requestLang } } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Legacy advice endpoint (for backward compatibility)
    if (url.pathname.endsWith("/interpret/advice")) {
      const { query, structure, meta, history } = body;
      const requestLang = body.lang || lang;
      
      // Forward to quick advice
      const fullLang = getFullLangName(requestLang);
      const quickSystem = `You are a practitioner of Vedic wisdom giving spiritual guidance.Return minified JSON.CRITICAL: Respond ENTIRELY in ${ fullLang }. Advise user to seek counsel from a qualified Rishi for deeper guidance.`;
      const quickUser = `Question: "${query}" Technical: ${ JSON.stringify(structure).substring(0, 3000) } `;
      const advice = await callAI(quickSystem, quickUser);
      return new Response(JSON.stringify({ success: true, advice: { ...advice, meta: { lang: requestLang } } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Legacy combined interpret endpoint (for backward compatibility)
    if (url.pathname.endsWith("/interpret")) {
      const { query, planets, lagnas, kavane, boundaries, meta, history } = body;
      const requestLang = body.lang || lang;

      let historyStr = "";
      if (history && history.length > 0) {
        historyStr = "\n--- SESSION MEMORY (RECENT INQUIRIES) ---\n" +
          history.map((h: any) => `
TIME: ${ h.time_ago }
QUERY: ${ h.question || h.cast?.question || "N/A" }
TECHNICAL ANALYSIS GIVEN: ${ h.technical_summary || "N/A" }
FINAL PREDICTION GIVEN: ${ h.spiritual_prediction || "N/A" }
------------------------------------------`).join("\n") + "\n";
      }

      // Phase 1: Structure/Technical
      const fullLangLegacy = getFullLangName(requestLang);
      const structureSystem = `You are a Vedic Jyotishi and technical expert in Ashtamangala Prasna.You MUST return JSON.
  CRITICAL: Respond ENTIRELY in ${ fullLangLegacy }. ALL text values MUST be in ${ fullLangLegacy }.
        
        Analyze the technical structure based on traditional Ashtamangala Deva Prasna principles(e.g.Shyamasundaradasa).
        Data provided:
- 108 cowrie shells(kavane) mapped to House(h) and Sign(s), 'u': 1(facing Up / Favorable) or 0(Down / Unfavorable).
        - planets(transit)
  - lagnas(Swarna Aroodham 'sa', Udaya Lagna 'ul_derived', etc).

    Analyze:
1. Spatial distribution of cowrie shells(favorable vs unfavorable ratios).
        2. Dominant / weak houses and signs.
        3. The relationship between Swarna Aroodham and Udaya Lagna.
        4. Evolution from previous questions in this session memory.

  Schema: {
  "analysis_title": "string",
    "sections": [{ "title": "string", "technical_analysis": "string", "colloquial_modern": "string" }],
      "concluding_insight": "string"
} `;

      const structureUser = `Analyze: Question "${query}", Data: ${ JSON.stringify({ meta, planets, lagnas, kavane, boundaries }) }.${ historyStr } `;
      const structure = await callAI(structureSystem, structureUser);

      // Phase 2: Advice
      const adviceSystem = `You are a practitioner of Vedic wisdom.You MUST return JSON.
  CRITICAL: Respond ENTIRELY in ${ fullLangLegacy }. ALL text values MUST be in ${ fullLangLegacy }.
      
        Provide authentic spiritual practices(upayas) grounded in Vedic texts.
        Include disclaimer: "Remedies refer to spiritual activities and materials for alleviation, not medical advice. Consult professionals for health concerns."
        Advise user to seek counsel from a qualified Rishi for deeper guidance.
        Do not hallucinate new age remedies.Be specific and compassionate.
  Schema: {
  "counsel_title": "string",
    "guidance_narrative": [{ "heading": "string", "content": "string" }],
      "specific_remedies": ["string"],
        "final_prediction": "string"
} `;

      const adviceUser = `Advice for: "${query}".Technical context: ${ JSON.stringify(structure) }.${ historyStr } `;
      const advice = await callAI(adviceSystem, adviceUser);

      return new Response(JSON.stringify({ success: true, structure, advice }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (url.pathname.includes("/export")) {
      const { cast, structure, advice, format = 'markdown', detailed = true, chakraImage } = body;
      const requestLang = body.lang || lang;
      const timestamp = new Date().toISOString();

      const exportData: ExportData = {
        cast,
        structure,
        advice,
        format: format as 'markdown' | 'pdf' | 'html',
        lang: requestLang,
        timestamp,
        chakraImage
      };

      // Note: formatDetailedContent was removed as it was redundant
      // The actual content from AI is already in structure and advice objects
      // No placeholder generation needed

      let content: string;
      let contentType: string;
      let filename: string;
      // Ensure cast.question is a string before calling replace
      const questionStr = typeof cast.question === 'string' ? cast.question : (cast.question ? String(cast.question) : 'reading');
      const safeQuestion = questionStr.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);

      switch (format) {
        case 'html':
          content = generateHTML(exportData);
          contentType = 'text/html';
          filename = `Ashtamangala_${ safeQuestion }_${ Date.now() }.html`;
          break;
        case 'pdf':
          // Generate actual PDF using pdf-lib
          const pdfBytes = await generatePDF(exportData);
          return new Response(pdfBytes, {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename = "Ashtamangala_${safeQuestion}_${Date.now()}.pdf"`
            }
          });
        case 'markdown':
        default:
          content = generateMarkdown(exportData);
          contentType = 'text/markdown';
          filename = `Ashtamangala_${ safeQuestion }_${ Date.now() }.md`;
          break;
      }

      return new Response(content, {
        headers: {
          ...corsHeaders,
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename = "${filename}"`
        }
      });
    }

    // ========================================================
    // LOCAL RESOURCES - Find temples, priests, stores near user
    // ========================================================
    if (url.pathname.includes("/local-resources")) {
      const { lat, lng, remedyType, materials, lang: requestLang = 'en' } = body;

      if (!lat || !lng) {
        return new Response(JSON.stringify({
          success: false,
          error: "Latitude and longitude required"
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const langNames: Record<string, string> = { en: "English", es: "Spanish (Español)", it: "Italian (Italiano)" };
      const fullLang = langNames[requestLang] || "English";

      const localSystem = `You are a Vedic resource advisor.Return minified JSON.

  CRITICAL: Respond ENTIRELY in ${ fullLang }. All text fields must be in ${ fullLang }.

IMPORTANT RULES - DO NOT HALLUCINATE:
- Do NOT invent specific temple names, addresses, phone numbers, or priest names
  - Do NOT fabricate distances or specific locations
    - Instead, describe the TYPES of places to search for using Google Maps
- Provide Google Maps search query strings that the user can use to find real places
  - For online resources, ONLY suggest well - known, verifiable websites

For the remedy type and materials, suggest:
1. What types of temples / religious places to search for (with Google Maps search queries)
2. What type of priests/pandits to look for
3. What type of stores to look for (with Google Maps search queries)
4. Verified online alternatives(only real, well - known websites like Amazon, Flipkart, Vedic Vaani, Puja Shoppe, etc.)

JSON SCHEMA:
{
  "search_suggestions": [
    {
      "category": "temple|priest|store",
      "search_query": "string - Google Maps search query for this type of place",
      "what_to_look_for": "string - description of what to search for",
      "notes": "string - tips on what to ask for"
    }
  ],
    "online_alternatives": [
      {
        "name": "string - real website name",
        "website": "string - real URL",
        "what_they_offer": "string"
      }
    ],
      "guidance": "string - general advice on finding resources for this remedy type",
        "disclaimer": "string - verify all details before visiting"
} `;

      const localUser = `Suggest how to find resources for:
Location coordinates: Latitude ${ lat }, Longitude ${ lng }
Remedy Type: ${ remedyType || 'General Vedic remedy' }
Materials Needed: ${ JSON.stringify(materials || []) }

Generate Google Maps search queries and guidance.Do NOT invent specific names or addresses.`;

      const resources = await callAI(localSystem, localUser);
      resources.meta = { lat, lng, remedyType, lang: requestLang, timestamp: new Date().toISOString() };

      return new Response(JSON.stringify({ success: true, resources }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    return new Response("Not Found", { status: 404 });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers: corsHeaders });
  }
});
