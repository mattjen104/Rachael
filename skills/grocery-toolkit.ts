import { rfetchJSON, rfetchText, throttledBatch, setDomainGap, sleep, humanDelay } from "./resilient-fetch";

export interface OFFProduct {
  code: string;
  name: string;
  brands: string;
  nutriScore: string;
  novaGroup: number;
  additives: string[];
  additiveCount: number;
  imageUrl: string | null;
  categories: string[];
  quantity: string;
}

export interface ProductSearchResult {
  products: OFFProduct[];
  count: number;
  page: number;
}

export interface ScoredProduct extends OFFProduct {
  healthScore: number;
}

setDomainGap("world.openfoodfacts.org", 600);

function parseOFFProduct(p: any): OFFProduct {
  return {
    code: p.code || p._id || "",
    name: p.product_name || p.product_name_en || "",
    brands: p.brands || "",
    nutriScore: (p.nutriscore_grade || p.nutrition_grades || "unknown").toLowerCase(),
    novaGroup: parseInt(p.nova_group, 10) || 0,
    additives: (p.additives_tags || []).map((a: string) => a.replace("en:", "")),
    additiveCount: p.additives_n || 0,
    imageUrl: p.image_front_small_url || p.image_url || null,
    categories: (p.categories_tags || []).map((c: string) => c.replace("en:", "")),
    quantity: p.quantity || "",
  };
}

export async function searchProducts(query: string, page: number = 1, pageSize: number = 10): Promise<ProductSearchResult> {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page=${page}&page_size=${pageSize}`;
  const data = await rfetchJSON(url, {
    maxRetries: 3,
    timeoutMs: 15000,
    stickySession: true,
    headers: { "User-Agent": "MealPlannerAgent/1.0 (contact@example.com)" },
  });
  return {
    products: (data.products || []).map(parseOFFProduct),
    count: data.count || 0,
    page: data.page || page,
  };
}

export async function getProductByBarcode(barcode: string): Promise<OFFProduct | null> {
  const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
  const data = await rfetchJSON(url, {
    maxRetries: 2,
    timeoutMs: 10000,
    stickySession: true,
    headers: { "User-Agent": "MealPlannerAgent/1.0 (contact@example.com)" },
  });
  if (data.status !== 1 || !data.product) return null;
  return parseOFFProduct(data.product);
}

const NUTRI_SCORE_VALUES: Record<string, number> = { a: 5, b: 4, c: 3, d: 2, e: 1, unknown: 0 };

export function computeHealthScore(product: OFFProduct): number {
  const nutriVal = NUTRI_SCORE_VALUES[product.nutriScore] || 0;
  const novaVal = product.novaGroup > 0 ? (5 - product.novaGroup) : 0;
  const additivePenalty = Math.min(product.additiveCount * 0.5, 3);
  return Math.max(0, (nutriVal * 10) + (novaVal * 5) - additivePenalty);
}

export function scoreAndRank(products: OFFProduct[]): ScoredProduct[] {
  return products
    .map(p => ({ ...p, healthScore: computeHealthScore(p) }))
    .sort((a, b) => b.healthScore - a.healthScore);
}

export async function findBestProduct(query: string, topN: number = 5): Promise<ScoredProduct[]> {
  const result = await searchProducts(query, 1, 20);
  const scored = scoreAndRank(result.products);
  return scored.slice(0, topN);
}

const SHELF_LIFE_DAYS: Record<string, number> = {
  "dairy": 7,
  "milk": 7,
  "yogurt": 14,
  "cheese": 30,
  "meat": 5,
  "poultry": 3,
  "fish": 2,
  "seafood": 2,
  "bread": 5,
  "bakery": 5,
  "produce": 7,
  "fruit": 7,
  "vegetable": 7,
  "frozen": 180,
  "canned": 730,
  "dry-goods": 365,
  "pasta": 730,
  "rice": 730,
  "cereal": 180,
  "snacks": 90,
  "crackers": 90,
  "condiment": 180,
  "sauce": 90,
  "beverage": 365,
  "juice": 14,
  "eggs": 21,
  "deli": 5,
  "nuts": 180,
  "oil": 365,
  "spice": 730,
  "other": 30,
};

export function estimateShelfLife(category: string): number {
  const lower = category.toLowerCase();
  for (const [key, days] of Object.entries(SHELF_LIFE_DAYS)) {
    if (lower.includes(key)) return days;
  }
  return SHELF_LIFE_DAYS["other"];
}

export function estimateExpirationDate(category: string, purchaseDate: Date = new Date()): Date {
  const days = estimateShelfLife(category);
  const exp = new Date(purchaseDate);
  exp.setDate(exp.getDate() + days);
  return exp;
}

export interface StoreProfile {
  name: string;
  baseUrl: string;
  searchUrl: (query: string) => string;
  selectors: {
    searchResults: string;
    productName: string;
    productPrice: string;
    addToCartButton: string;
  };
}

export const walmartProfile: StoreProfile = {
  name: "walmart",
  baseUrl: "https://www.walmart.com",
  searchUrl: (query: string) => `https://www.walmart.com/search?q=${encodeURIComponent(query)}`,
  selectors: {
    searchResults: '[data-testid="list-view"]',
    productName: '[data-automation-id="product-title"]',
    productPrice: '[data-automation-id="product-price"] .f2',
    addToCartButton: '[data-tl-id="ProductTileAddToCartBtn"]',
  },
};

export const costcoProfile: StoreProfile = {
  name: "costco",
  baseUrl: "https://www.costco.com",
  searchUrl: (query: string) => `https://www.costco.com/CatalogSearch?dept=All&keyword=${encodeURIComponent(query)}`,
  selectors: {
    searchResults: ".product-list",
    productName: ".description a",
    productPrice: ".price",
    addToCartButton: "#add-to-cart-btn",
  },
};

export function getStoreProfile(store: string): StoreProfile | null {
  switch (store.toLowerCase()) {
    case "walmart": return walmartProfile;
    case "costco": return costcoProfile;
    default: return null;
  }
}

export const APPLIANCES = [
  "Instant Pot",
  "sous vide",
  "rice cooker",
  "stove",
  "toaster oven",
  "crockpot",
] as const;

export type Appliance = typeof APPLIANCES[number];

export const DEFAULT_DIETARY_PREFS = {
  householdSize: 3,
  dietaryRestrictions: [] as string[],
  allergies: [] as string[],
  cuisinePreferences: ["American", "Italian", "Mexican", "Asian"],
  appliances: [...APPLIANCES] as string[],
  kiddoName: "Willa",
  kiddoCurrentFavorites: ["Go-Gurt", "chicken nuggets", "Goldfish crackers"],
};
