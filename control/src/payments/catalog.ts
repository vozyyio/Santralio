// Sağlayıcı kataloğu: işletme panelde buradan seçer ve kendi bilgilerini girer.
// status: available = bağlanabilir; planned = katalogda görünür, henüz bağlanamaz.
// Yalnızca kart bilgisini sağlayıcının kendi güvenli sayfasında alan (ortak ödeme sayfası / 3D) yöntemler desteklenir.

import { iyzico } from "./providers/iyzico.ts";
import { paytr } from "./providers/paytr.ts";
import { testProvider } from "./providers/test.ts";
import type { PaymentProvider } from "./types.ts";

export type Field = { key: string; label: string; secret: boolean; hint?: string };
export type CatalogEntry = {
  id: string;
  name: string;
  kind: "psp" | "bank" | "international" | "test";
  status: "available" | "planned";
  banks?: string[]; // bu altyapıyı kullanan bankalar (bilgi amaçlı; banka ile teyit edilir)
  fields: Field[];
  features: { link: boolean; providerSms: boolean; secureDtmf: boolean; installments: boolean };
  docs?: string;
  impl?: PaymentProvider;
};

const bankFields: Field[] = [
  { key: "merchant_id", label: "Üye işyeri numarası", secret: false },
  { key: "api_user", label: "API kullanıcı adı", secret: false },
  { key: "api_password", label: "API şifresi", secret: true },
  { key: "store_key", label: "3D / mağaza anahtarı", secret: true },
];
const planned = (id: string, name: string, kind: CatalogEntry["kind"], banks?: string[], fields = bankFields): CatalogEntry => ({
  id,
  name,
  kind,
  status: "planned",
  banks,
  fields,
  features: { link: true, providerSms: false, secureDtmf: false, installments: true },
});

export const CATALOG: CatalogEntry[] = [
  {
    id: "paytr",
    name: "PayTR",
    kind: "psp",
    status: "available",
    fields: [
      { key: "merchant_id", label: "Mağaza no", secret: false },
      { key: "merchant_key", label: "Merchant key", secret: true },
      { key: "merchant_salt", label: "Merchant salt", secret: true },
    ],
    features: { link: true, providerSms: true, secureDtmf: false, installments: true },
    docs: "https://dev.paytr.com/link-api",
    impl: paytr,
  },
  {
    id: "iyzico",
    name: "iyzico",
    kind: "psp",
    status: "available",
    fields: [
      { key: "api_key", label: "API anahtarı", secret: false },
      { key: "secret_key", label: "Gizli anahtar", secret: true },
    ],
    features: { link: true, providerSms: false, secureDtmf: false, installments: true },
    docs: "https://docs.iyzico.com/urunler/iyzilink/iyzilink-api",
    impl: iyzico,
  },
  planned("param", "Param", "psp", undefined, [
    { key: "client_code", label: "Client code", secret: false },
    { key: "client_username", label: "Kullanıcı adı", secret: false },
    { key: "client_password", label: "Şifre", secret: true },
    { key: "guid", label: "GUID", secret: true },
  ]),
  planned("paynet", "Paynet", "psp"),
  planned("sipay", "Sipay", "psp"),
  planned("moka", "Moka United", "psp"),
  planned("nestpay", "NestPay (Asseco) sanal POS", "bank", ["İş Bankası", "Akbank", "Halkbank", "Ziraat Bankası", "TEB", "QNB", "ING", "Şekerbank"]),
  planned("garanti", "Garanti BBVA Sanal POS", "bank", ["Garanti BBVA"]),
  planned("posnet", "Posnet (Yapı Kredi)", "bank", ["Yapı Kredi"]),
  planned("payflex", "PayFlex VPOS", "bank", ["VakıfBank", "Ziraat Bankası", "Halkbank"]),
  planned("kuveytturk", "Kuveyt Türk Sanal POS", "bank", ["Kuveyt Türk"]),
  planned("denizbank", "DenizBank InterVPOS", "bank", ["DenizBank"]),
  planned("stripe", "Stripe", "international", undefined, [{ key: "secret_key", label: "Secret key", secret: true }]),
  {
    id: "test",
    name: "Santralio test sağlayıcısı",
    kind: "test",
    status: "available",
    fields: [{ key: "label", label: "Not (isteğe bağlı)", secret: false }],
    features: { link: true, providerSms: false, secureDtmf: false, installments: false },
    impl: testProvider,
  },
];

export const catalogEntry = (id: string) => CATALOG.find((c) => c.id === id) ?? null;

// Panele gönderilen hali (uygulama nesnesi olmadan).
export const publicCatalog = () => CATALOG.map(({ impl: _impl, ...c }) => c);
