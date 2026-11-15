// Santralio: kurulum adımları. Yeni işletmenin "neyi tamamladım, sırada ne var" listesi (Özet ekranında).
// Durum veritabanından hesaplanır; ayrı bir ilerleme kaydı tutulmaz.

import type { Db } from "./db.ts";

export type Step = { id: string; title: string; detail: string; done: boolean; required: boolean; tab: string; app: "panel" | "crm" };

export async function steps(db: Db, tenantId: number, registered: boolean | null): Promise<Step[]> {
  const r = (
    await db.query(
      `SELECT
         (SELECT count(*) FROM trunks WHERE tenant_id = $1 AND enabled)::int AS trunks,
         (SELECT count(*) FROM entry_points WHERE tenant_id = $1 AND enabled AND channel = 'voice')::int AS numbers,
         (SELECT count(*) FROM extensions WHERE tenant_id = $1 AND enabled)::int AS extensions,
         (SELECT count(*) FROM queues WHERE tenant_id = $1)::int AS queues,
         (SELECT count(*) FROM queue_members m JOIN queues q ON q.id = m.queue_id WHERE q.tenant_id = $1)::int AS members,
         (SELECT count(*) FROM schedules WHERE tenant_id = $1)::int AS schedules,
         (SELECT count(*) FROM users WHERE tenant_id = $1 AND NOT disabled)::int AS users,
         (SELECT ai_enabled FROM tenants WHERE id = $1) AS ai_enabled,
         (SELECT count(*) FROM ai_flows WHERE tenant_id = $1 AND enabled)::int AS flows,
         (SELECT count(*) FROM booking_settings WHERE tenant_id = $1 AND mode <> 'off')::int AS booking,
         (SELECT count(*) FROM chat_widgets WHERE tenant_id = $1 AND enabled)::int AS chat,
         (SELECT count(*) FROM payment_providers WHERE tenant_id = $1 AND enabled)::int AS payments`,
      [tenantId],
    )
  ).rows[0];
  const list: Step[] = [
    {
      id: "trunk",
      title: "Operatör hattını bağlayın",
      detail: r.trunks ? (registered === false ? "Hat tanımlı ama operatöre kayıtlı değil; bilgileri kontrol edin." : "Hat tanımlı.") : "Netgsm, Verimor vb. SIP hesabınızın bilgilerini girin.",
      done: r.trunks > 0 && registered !== false,
      required: true,
      tab: "genel",
      app: "panel",
    },
    {
      id: "extensions",
      title: "Dahilileri ekleyin",
      detail: r.extensions ? `${r.extensions} dahili var.` : "Her temsilci için bir dahili açın (telefon, uygulama ya da tarayıcı).",
      done: r.extensions > 0,
      required: true,
      tab: "dahililer",
      app: "panel",
    },
    {
      id: "queues",
      title: "Kuyruk ve üyelerini belirleyin",
      detail: r.queues ? (r.members ? `${r.queues} kuyruk, ${r.members} üye.` : "Kuyrukta üye yok; aramalar kimseye düşmez.") : "Aramaların çalacağı ekibi (rezervasyon, resepsiyon…) tanımlayın.",
      done: r.queues > 0 && r.members > 0,
      required: true,
      tab: "kuyruklar",
      app: "panel",
    },
    {
      id: "number",
      title: "Numarayı yönlendirin",
      detail: r.numbers ? "Gelen arama yönü tanımlı." : "Numaranıza gelen aramanın nereye gideceğini seçin (kuyruk, menü, yapay zekâ).",
      done: r.numbers > 0,
      required: true,
      tab: "genel",
      app: "panel",
    },
    {
      id: "schedule",
      title: "Çalışma saatlerini girin",
      detail: r.schedules ? "Tanımlı." : "Mesai dışında aramalar anons, kuyruk ya da yapay zekâya gitsin.",
      done: r.schedules > 0,
      required: false,
      tab: "saatler",
      app: "panel",
    },
    {
      id: "staff",
      title: "Ekibinizi davet edin",
      detail: r.users > 1 ? `${r.users} kullanıcı.` : "Temsilci ve yöneticiler için hesap açın, rollerini seçin.",
      done: r.users > 1,
      required: false,
      tab: "personel",
      app: "panel",
    },
  ];
  if (r.ai_enabled) {
    list.push(
      {
        id: "ai",
        title: "Yapay zekâ karşılamasını hazırlayın",
        detail: r.flows ? "Akış açık." : "Şirket bilgilerini ve yönlendirmeleri yazın, numaraya bağlayın.",
        done: r.flows > 0,
        required: false,
        tab: "yapayzeka",
        app: "panel",
      },
      {
        id: "booking",
        title: "Rezervasyonu açın",
        detail: r.booking ? "Açık." : "Asistan telefonda ve sitede rezervasyon alsın.",
        done: r.booking > 0,
        required: false,
        tab: "rezervasyon",
        app: "panel",
      },
      {
        id: "chat",
        title: "Sitenize sohbet ekleyin",
        detail: r.chat ? "Açık." : "Tek satır kodla sitenizde yapay zekâ sohbeti.",
        done: r.chat > 0,
        required: false,
        tab: "websohbet",
        app: "panel",
      },
    );
  }
  list.push({
    id: "payments",
    title: "Ödeme almaya başlayın",
    detail: r.payments ? "Ödeme kuruluşu bağlı." : "Banka / ödeme kuruluşunuzu bağlayın; telefonda ve sohbette ödeme bağlantısı gönderin.",
    done: r.payments > 0,
    required: false,
    tab: "odeme",
    app: "panel",
  });
  return list;
}
