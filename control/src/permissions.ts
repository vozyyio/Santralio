// Santralio: yetki kataloğu ve başlangıç rolleri.
// Kiracı, panelden istediği adla rol açar ve bu yetkilerden istediklerini işaretler.
// Yeni yetki eklemek için buraya eklenir; panel listeyi /api/permissions'tan alır.

export const PERMISSIONS = {
  "agent.desk": "Temsilci masası: arama alma, aktarma, mola",
  "agent.outbound": "Dış arama yapma (müşterinin dış arama politikası içinde)",
  "calls.own": "Kendi görüşmelerini görme",
  "calls.all": "Bütün görüşmeleri görme",
  "recordings.listen": "Görebildiği görüşmelerin kaydını dinleme",
  "reports.view": "Raporlar",
  "audit.view": "İşlem günlüğü",
  "crm.use": "CRM: müşteri kartları ve notlar",
  "settings.manage": "Santral ayarları: numara, menü, anons, çalışma saati, kuyruk, dahili, kayıt",
  "staff.manage": "Personel ve roller",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const isPermission = (p: string): p is Permission => p in PERMISSIONS;

// Yeni kiracıya açılan roller (009 migration'ındaki değerlerle aynı).
export const DEFAULT_ROLES: { name: string; permissions: Permission[] }[] = [
  { name: "Patron", permissions: ALL_PERMISSIONS },
  { name: "Müdür", permissions: ALL_PERMISSIONS },
  {
    name: "Süpervizör",
    permissions: ["agent.desk", "agent.outbound", "calls.own", "calls.all", "recordings.listen", "reports.view", "crm.use"],
  },
  { name: "Temsilci", permissions: ["agent.desk", "calls.own", "crm.use"] },
];

// Üç adres ve açılmaları için gereken yetkiler (herhangi biri yeterli).
export const APPS = {
  panel: ["settings.manage", "staff.manage"],
  crm: ["calls.own", "calls.all", "reports.view", "audit.view", "crm.use"],
  agent: ["agent.desk"],
} as const satisfies Record<string, readonly Permission[]>;
export type App = keyof typeof APPS;

// Lisans modülleri ve kapattıkları yetkiler (Vozyy lisansı; bkz. vozyy.ts).
const MODULE_PERMISSIONS: Record<string, Permission[]> = {
  agent_desk: ["agent.desk", "agent.outbound"],
  outbound: ["agent.outbound"],
  recording: ["recordings.listen"],
  reports: ["reports.view"],
  crm: ["crm.use"],
};

// Vozyy lisanslı kiracıda modülü olmayan yetkiler düşer (manuel lisans: modules null, her şey açık).
export function effectivePermissions(perms: Permission[], modules: string[] | null): Permission[] {
  if (!modules) return perms;
  return perms.filter((p) => Object.entries(MODULE_PERMISSIONS).every(([m, list]) => !list.includes(p) || modules.includes(m)));
}
export const hasModule = (modules: string[] | null, m: string) => !modules || modules.includes(m);
