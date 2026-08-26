import itemData from "./assets/items.json";

export interface InventoryItem {
    name: string;
    quantity: number;
}

export interface ItemCategory {
    name: string;
    items: string[];
}

// Quick-pick groups for the panel's item picker. Not a whitelist - the panel
// also accepts a typed-in name for anything not listed here.
export const itemCategories: ItemCategory[] = itemData.categories;

// Items are matched case-insensitively so "potion" and "Potion" stack rather
// than becoming two separate entries.
export function sameItem(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}

// Reads back an inventory from persisted (untyped) chat state, dropping
// anything malformed and normalising quantities.
export function parseInventory(raw: any): InventoryItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(item => item && typeof item.name === 'string' && item.name.trim().length > 0)
        .map(item => ({
            name: item.name.trim(),
            quantity: Math.max(Math.floor(Number(item.quantity)) || 1, 1)
        }));
}
