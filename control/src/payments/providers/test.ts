// Santralio test sağlayıcısı: gerçek para hareketi olmadan uçtan uca akışı denemek için.
// Bağlantı Santralio'nun kendi test sayfasına gider; orada "Ödendi" ya da "Başarısız" seçilir.
// Yalnızca test modunda kullanılabilir.

import { ProviderError, type PaymentProvider } from "../types.ts";

export const TEST_PAGE_PATH = "/api/payments/test-page/";

export const testProvider: PaymentProvider = {
  validate: () => null,
  async test() {},
  async createLink(_c, mode, req) {
    if (mode !== "test") throw new ProviderError("test sağlayıcısı yalnızca test modunda çalışır");
    const base = new URL(req.callbackUrl).origin;
    return { providerRef: `test_${req.reference.slice(4)}`, url: `${base}${TEST_PAGE_PATH}${req.reference}` };
  },
};
