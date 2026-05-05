// Single source of truth for company metadata (name, sector, industry, short
// description) across the entire US + ASX universe. Extending the watchlist
// means adding a row here — `marketRegistry` will pick it up automatically.
//
// Sector buckets are intentionally a *simplified* GICS-derived taxonomy (9
// buckets) so the dashboard chip filters stay readable on mobile. The full
// GICS sub-industry is captured in `industry` for the Companies-tab tooltips.

const COMPANIES = {
  // ---- US Mega-cap Tech ---------------------------------------------------
  AAPL:  { name: 'Apple Inc.',                sector: 'Technology',         industry: 'Consumer Electronics',           description: 'iPhone, Mac, services. World’s largest company by market cap; cash machine with growing services mix.' },
  MSFT:  { name: 'Microsoft',                 sector: 'Technology',         industry: 'Software & Cloud',               description: 'Windows, Office 365, Azure cloud. Heavy AI investment via OpenAI partnership and Copilot suite.' },
  GOOGL: { name: 'Alphabet (Google)',         sector: 'Technology',         industry: 'Internet & Search',              description: 'Google Search, YouTube, Android, Cloud, Gemini AI. Ad-revenue dominant with growing cloud business.' },
  META:  { name: 'Meta Platforms',            sector: 'Technology',         industry: 'Social Media & VR',              description: 'Facebook, Instagram, WhatsApp, Reality Labs. Ad-funded social giant pivoting to AI + immersive.' },
  AMZN:  { name: 'Amazon.com',                sector: 'Consumer',           industry: 'E-commerce & Cloud (AWS)',       description: 'World’s largest e-commerce + leading cloud provider (AWS). Margin expansion story driven by AWS + ads.' },
  NFLX:  { name: 'Netflix',                   sector: 'Technology',         industry: 'Streaming Media',                description: 'Global subscription video. Pivoted to ad-tier + password sharing crackdown for re-acceleration.' },
  TSLA:  { name: 'Tesla',                     sector: 'Consumer',           industry: 'EVs & Energy Storage',           description: 'EV maker pivoting to AI/robotaxi narrative. High-beta name with energy + Optimus optionality.' },

  // ---- US Semiconductors --------------------------------------------------
  NVDA:  { name: 'NVIDIA',                    sector: 'Semiconductors',     industry: 'AI Accelerators',                description: 'Dominant GPU supplier for AI training/inference. CUDA moat + data-center hyperscaler demand.' },
  AMD:   { name: 'Advanced Micro Devices',    sector: 'Semiconductors',     industry: 'CPUs & GPUs',                    description: 'CPU + GPU challenger to Intel/Nvidia. MI300 AI accelerator ramp + EPYC server share gains.' },
  AVGO:  { name: 'Broadcom',                  sector: 'Semiconductors',     industry: 'Networking & Custom Silicon',    description: 'Networking chips, custom AI ASICs (Google TPU partner) + VMware enterprise software.' },
  INTC:  { name: 'Intel',                     sector: 'Semiconductors',     industry: 'CPUs & Foundry',                 description: 'Legacy x86 CPU leader rebuilding foundry business. Turnaround story with execution risk.' },
  MU:    { name: 'Micron Technology',         sector: 'Semiconductors',     industry: 'Memory (DRAM/NAND)',             description: 'Pure-play memory cyclical. HBM3 supply for AI accelerators is the new growth lever.' },
  QCOM:  { name: 'Qualcomm',                  sector: 'Semiconductors',     industry: 'Mobile & Auto Chips',            description: 'Snapdragon mobile SoCs, automotive + IoT diversification. Apple-modem revenue tail risk.' },
  TSM:   { name: 'Taiwan Semiconductor (ADR)',sector: 'Semiconductors',     industry: 'Foundry',                        description: 'World’s leading chip foundry — fabricates for Apple, Nvidia, AMD. 3nm + 2nm node leadership.' },

  // ---- US Financials ------------------------------------------------------
  JPM:   { name: 'JPMorgan Chase',            sector: 'Financials',         industry: 'Money-Center Bank',              description: 'Largest US bank — diversified across IB, retail, AM. Net-interest-income beneficiary.' },
  BAC:   { name: 'Bank of America',           sector: 'Financials',         industry: 'Money-Center Bank',              description: 'Big-four US bank. Heavy retail deposit franchise; rate-sensitive earnings.' },
  GS:    { name: 'Goldman Sachs',             sector: 'Financials',         industry: 'Investment Bank',                description: 'Premier IB & trading franchise. Deal-cycle + asset-management driven earnings.' },
  V:     { name: 'Visa',                      sector: 'Financials',         industry: 'Payments Network',               description: 'Global card-payments network. Toll-road business model on consumer + cross-border spend.' },

  // ---- US Consumer (Staples + Discretionary) ------------------------------
  COST:  { name: 'Costco Wholesale',          sector: 'Consumer',           industry: 'Warehouse Retail',               description: 'Membership warehouse retailer. Sticky subscriber base + steady comp growth.' },
  WMT:   { name: 'Walmart',                   sector: 'Consumer',           industry: 'Mass-Market Retail',             description: 'World’s largest retailer. E-commerce + advertising are the new margin levers.' },
  HD:    { name: 'Home Depot',                sector: 'Consumer',           industry: 'Home Improvement',               description: 'Largest home-improvement retailer. Housing-cycle + rates sensitive.' },
  MCD:   { name: 'McDonald’s',                sector: 'Consumer',           industry: 'Quick-Service Restaurants',      description: 'Global QSR franchise. Defensive cash flow + dividend grower.' },

  // ---- US Healthcare ------------------------------------------------------
  JNJ:   { name: 'Johnson & Johnson',         sector: 'Healthcare',         industry: 'Diversified Pharma & Devices',   description: 'Pharma + medtech (post-Kenvue spin). Defensive dividend aristocrat.' },
  PFE:   { name: 'Pfizer',                    sector: 'Healthcare',         industry: 'Big Pharma',                     description: 'Big pharma post-COVID reset. Pipeline + Seagen oncology integration are key.' },
  LLY:   { name: 'Eli Lilly',                 sector: 'Healthcare',         industry: 'Big Pharma (GLP-1)',             description: 'GLP-1 leader (Mounjaro/Zepbound). Diabetes + obesity TAM expansion driving premium multiple.' },
  UNH:   { name: 'UnitedHealth Group',        sector: 'Healthcare',         industry: 'Managed Care + Optum',           description: 'Largest US managed-care insurer + Optum services arm. Scale + vertical integration moat.' },

  // ---- US Energy ----------------------------------------------------------
  XOM:   { name: 'Exxon Mobil',               sector: 'Energy',             industry: 'Integrated Oil & Gas',           description: 'Largest US integrated oil major. Capital-discipline + buybacks story.' },
  CVX:   { name: 'Chevron',                   sector: 'Energy',             industry: 'Integrated Oil & Gas',           description: 'US integrated oil major. Hess acquisition + Permian focus.' },

  // ---- US ETFs ------------------------------------------------------------
  SPY:   { name: 'SPDR S&P 500 ETF',          sector: 'ETFs',               industry: 'Broad Market Index',             description: 'Tracks the S&P 500. Most-traded ETF in the world — used as a market proxy + macro overlay.' },
  QQQ:   { name: 'Invesco QQQ',               sector: 'ETFs',               industry: 'Nasdaq-100 Index',               description: 'Tracks the Nasdaq-100. Tech-heavy — high-beta proxy for growth + tech regime.' },

  // ---- ASX Financials -----------------------------------------------------
  CBA:   { name: 'Commonwealth Bank',         sector: 'Financials',         industry: 'Big-4 Australian Bank',          description: 'Largest Australian bank by mcap. Retail-mortgage heavy; premium valuation vs peers.' },
  WBC:   { name: 'Westpac',                   sector: 'Financials',         industry: 'Big-4 Australian Bank',          description: 'Big-four Australian bank. Domestic mortgage franchise + business banking.' },
  NAB:   { name: 'National Australia Bank',   sector: 'Financials',         industry: 'Big-4 Australian Bank',          description: 'Big-four Australian bank. Skews to business banking + agribusiness.' },
  ANZ:   { name: 'ANZ Banking Group',         sector: 'Financials',         industry: 'Big-4 Australian Bank',          description: 'Big-four Australian bank with NZ + institutional exposure.' },
  MQG:   { name: 'Macquarie Group',           sector: 'Financials',         industry: 'Investment Bank & Asset Mgr',    description: 'Global investment bank + infra/green-energy asset manager. Diversified, high ROE.' },

  // ---- ASX Materials & Mining --------------------------------------------
  BHP:   { name: 'BHP Group',                 sector: 'Materials & Mining', industry: 'Diversified Miner',              description: 'World’s largest diversified miner. Iron ore + copper + potash. China-demand sensitive.' },
  RIO:   { name: 'Rio Tinto',                 sector: 'Materials & Mining', industry: 'Iron Ore + Copper',              description: 'Anglo-Australian miner. Iron-ore Pilbara cash machine; copper + lithium for the energy transition.' },
  FMG:   { name: 'Fortescue',                 sector: 'Materials & Mining', industry: 'Pure-play Iron Ore',             description: 'Pure-play iron ore producer + green-hydrogen optionality. Highest leverage to iron-ore price.' },
  S32:   { name: 'South32',                   sector: 'Materials & Mining', industry: 'Diversified (Al, Mn, Coal)',     description: 'BHP spin-off. Aluminium, manganese, met-coal — diversified base-metals exposure.' },
  PLS:   { name: 'Pilbara Minerals',          sector: 'Materials & Mining', industry: 'Lithium',                        description: 'Pure-play lithium spodumene producer. EV-battery demand sensitive; volatile.' },
  MIN:   { name: 'Mineral Resources',         sector: 'Materials & Mining', industry: 'Lithium + Iron Ore + Services',  description: 'Diversified miner — lithium, iron ore, mining services. High-leverage to commodity cycle.' },
  JHX:   { name: 'James Hardie Industries',   sector: 'Materials & Mining', industry: 'Building Materials (Fibre Cement)', description: 'Global fibre-cement leader. US housing-cycle + remodelling exposure.' },

  // ---- ASX Healthcare -----------------------------------------------------
  CSL:   { name: 'CSL Limited',               sector: 'Healthcare',         industry: 'Blood Plasma & Biotech',         description: 'Global blood-plasma + vaccine leader. Defensive growth; #2 ASX by mcap.' },
  RMD:   { name: 'ResMed',                    sector: 'Healthcare',         industry: 'Sleep Apnea Devices',            description: 'Global leader in CPAP devices for sleep apnea. GLP-1 narrative is the swing factor.' },
  COH:   { name: 'Cochlear',                  sector: 'Healthcare',         industry: 'Hearing Implants',               description: 'Global leader in cochlear (hearing) implants. Premium-multiple medtech.' },

  // ---- ASX Tech & Online --------------------------------------------------
  REA:   { name: 'REA Group',                 sector: 'Technology',         industry: 'Online Real Estate',             description: 'Operates realestate.com.au. Dominant ANZ property-listing platform; News Corp affiliated.' },
  XRO:   { name: 'Xero',                      sector: 'Technology',         industry: 'Cloud Accounting (SaaS)',        description: 'Global cloud accounting SaaS. Subscription growth + pricing power story.' },
  CPU:   { name: 'Computershare',             sector: 'Financials',         industry: 'Share Registry & Fintech',       description: 'Global share-registry + corporate-trust services. Rate-sensitive margin income.' },

  // ---- ASX Consumer -------------------------------------------------------
  WOW:   { name: 'Woolworths Group',          sector: 'Consumer',           industry: 'Supermarkets',                   description: 'Largest Australian supermarket chain. Defensive staples cash flow.' },
  WES:   { name: 'Wesfarmers',                sector: 'Consumer',           industry: 'Diversified Retail',             description: 'Owns Bunnings, Kmart, Officeworks. Best-in-class retail conglomerate.' },
  ALL:   { name: 'Aristocrat Leisure',        sector: 'Consumer',           industry: 'Gaming Machines + Online',       description: 'Global gaming-machine + online-gaming leader. Pixel-United mobile gaming arm.' },

  // ---- ASX Industrials, Logistics, REITs ----------------------------------
  TCL:   { name: 'Transurban',                sector: 'Industrials',        industry: 'Toll-Road Operator',             description: 'Toll-road operator (AU/US). Inflation-linked tolls; bond-proxy infrastructure name.' },
  BXB:   { name: 'Brambles',                  sector: 'Industrials',        industry: 'Pallet Pooling (CHEP)',          description: 'Global pallet-pooling network (CHEP). Pricing power + supply-chain bellwether.' },
  GMG:   { name: 'Goodman Group',             sector: 'Industrials',        industry: 'Industrial REIT (Logistics)',    description: 'Industrial REIT focused on logistics + data-centre conversions. AI/cloud tailwind.' },

  // ---- ASX Energy ---------------------------------------------------------
  STO:   { name: 'Santos',                    sector: 'Energy',             industry: 'Oil & Gas + LNG',                description: 'Australian oil & gas producer. LNG export exposure to Asian demand.' },
  ORG:   { name: 'Origin Energy',             sector: 'Energy',             industry: 'Utility + LNG',                  description: 'Australian utility (electricity/gas) + LNG export stake (APLNG).' },
  WDS:   { name: 'Woodside Energy',           sector: 'Energy',             industry: 'LNG Major',                      description: 'Australia’s largest oil & gas producer. LNG-export heavy; Asian-demand sensitive.' },
};

// Ordered list of buckets — drives chip ordering in the UI.
const SECTORS = [
  'Technology',
  'Semiconductors',
  'Financials',
  'Consumer',
  'Healthcare',
  'Energy',
  'Materials & Mining',
  'Industrials',
  'ETFs',
];

function getCompanyInfo(symbol) {
  const sym = String(symbol || '').toUpperCase();
  return COMPANIES[sym] || null;
}

function getSector(symbol) {
  const c = getCompanyInfo(symbol);
  return c ? c.sector : 'Other';
}

module.exports = { COMPANIES, SECTORS, getCompanyInfo, getSector };
