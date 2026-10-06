-- CreateTable
CREATE TABLE "price_cars" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_class" TEXT,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_cars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_zones" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "service_package" TEXT NOT NULL,
    "included" TEXT NOT NULL,
    "excluded" TEXT NOT NULL,
    "note" TEXT,
    "default_for_unlisted" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_rates" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "car_id" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "is_proposal" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_surcharges" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_surcharges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_cities" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "driver_zone_id" TEXT,
    "all_in_zone_id" TEXT,
    "quote" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_extras" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2),
    "percent" DECIMAL(5,2),
    "unit" TEXT NOT NULL,
    "note" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_change_logs" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_publications" (
    "id" TEXT NOT NULL,
    "snapshot" JSON NOT NULL,
    "note" TEXT,
    "client_ref" TEXT,
    "published_by" TEXT,
    "deploy_status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_cars_slug_key" ON "price_cars"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "price_zones_code_key" ON "price_zones"("code");

-- CreateIndex
CREATE INDEX "price_rates_car_id_idx" ON "price_rates"("car_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_rates_zone_id_car_id_duration_key" ON "price_rates"("zone_id", "car_id", "duration");

-- CreateIndex
CREATE UNIQUE INDEX "price_surcharges_zone_id_area_key" ON "price_surcharges"("zone_id", "area");

-- CreateIndex
CREATE UNIQUE INDEX "price_cities_slug_key" ON "price_cities"("slug");

-- CreateIndex
CREATE INDEX "price_cities_driver_zone_id_idx" ON "price_cities"("driver_zone_id");

-- CreateIndex
CREATE INDEX "price_cities_all_in_zone_id_idx" ON "price_cities"("all_in_zone_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_extras_code_key" ON "price_extras"("code");

-- CreateIndex
CREATE INDEX "price_change_logs_created_at_idx" ON "price_change_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "price_publications_client_ref_key" ON "price_publications"("client_ref");

-- CreateIndex
CREATE INDEX "price_publications_created_at_idx" ON "price_publications"("created_at");

-- AddForeignKey
ALTER TABLE "price_rates" ADD CONSTRAINT "price_rates_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "price_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_rates" ADD CONSTRAINT "price_rates_car_id_fkey" FOREIGN KEY ("car_id") REFERENCES "price_cars"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_surcharges" ADD CONSTRAINT "price_surcharges_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "price_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_cities" ADD CONSTRAINT "price_cities_driver_zone_id_fkey" FOREIGN KEY ("driver_zone_id") REFERENCES "price_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_cities" ADD CONSTRAINT "price_cities_all_in_zone_id_fkey" FOREIGN KEY ("all_in_zone_id") REFERENCES "price_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Supabase: the public schema runs with RLS on and no policies (the API
-- connects as the table owner). New tables must follow, or anon/authenticated
-- could reach them through the REST API.
ALTER TABLE "price_cars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_surcharges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_cities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_extras" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_change_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_publications" ENABLE ROW LEVEL SECURITY;


-- Seed: the official price list of 6 Oct 2026 (dashboard-arasya-rentcar
-- docs/PRICE.md). Nothing is published here: the owner reviews the list in
-- the dashboard and publishes it from there. ON CONFLICT DO NOTHING keeps a
-- re-run harmless and never overwrites an edited price.

-- Cars: the 14 cars of the website fleet (Sanity slugs).
INSERT INTO "price_cars" ("id", "slug", "name", "price_class", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid()::text, v."slug", v."name", v."price_class", v."sort_order", now(), now()
FROM (VALUES
  ('toyota-avanza', 'Toyota Avanza', 'Avanza sekelas', 0),
  ('suzuki-ertiga', 'Suzuki Ertiga', 'Avanza sekelas', 1),
  ('mitsubishi-xpander', 'Mitsubishi Xpander', 'Veloz/Xpander', 2),
  ('daihatsu-terios', 'Daihatsu Terios', 'Veloz/Xpander', 3),
  ('toyota-rush', 'Toyota Rush', 'Veloz/Xpander', 4),
  ('toyota-innova-reborn', 'Toyota Innova Reborn', 'Innova Reborn', 5),
  ('toyota-zenix', 'Toyota Zenix', 'Innova Zenix', 6),
  ('toyota-innova-venturer', 'Toyota Innova Venturer', 'Innova Zenix', 7),
  ('toyota-zenix-q-hybrid-modellista', 'Toyota Zenix Q Hybrid Modellista', 'Innova Zenix Q', 8),
  ('toyota-fortuner', 'Toyota Fortuner', 'Fortuner/Pajero', 9),
  ('toyota-hiace-commuter', 'Toyota Hiace Commuter', NULL, 10),
  ('toyota-hiace-premio', 'Toyota Hiace Premio', NULL, 11),
  ('toyota-alphard', 'Toyota Alphard', NULL, 12),
  ('isuzu-elf-long', 'Isuzu Elf Long', NULL, 13)
) AS v("slug", "name", "price_class", "sort_order")
ON CONFLICT ("slug") DO NOTHING;

-- Tables (zones).
INSERT INTO "price_zones" ("id", "code", "name", "service_package", "included", "excluded", "note", "default_for_unlisted", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid()::text, v."code", v."name", v."service_package", v."included", v."excluded", v."note", v."default_for_unlisted", v."sort_order", now(), now()
FROM (VALUES
  ('JABODETABEK', 'Mobil + Supir Jabodetabek', 'XOPS',
   'Mobil dan supir.',
   'BBM, tol, parkir/tiket masuk wisata, dan makan supir. Tip supir seikhlasnya.',
   NULL, false, 0),
  ('LUAR_KOTA', 'Mobil + Supir Luar Jabodetabek / Luar Kota', 'XOPS',
   'Mobil dan supir.',
   'BBM, tol, parkir/tiket masuk wisata, dan makan supir. Tip supir seikhlasnya.',
   'Perjalanan luar kota yang selesai di kota awal, dan pemakaian di kota di luar Jabodetabek.', true, 1),
  ('JAKARTA', 'All-in Jakarta', 'ALL-IN X PARKIR',
   'Mobil, supir, BBM, tol, dan makan supir.',
   'Parkir/tiket masuk wisata. Tip supir seikhlasnya.',
   NULL, false, 2),
  ('BANDUNG', 'All-in Bandung', 'ALL-IN X PARKIR',
   'Mobil, supir, BBM, tol, dan makan supir.',
   'Parkir/tiket masuk wisata. Tip supir seikhlasnya.',
   NULL, false, 3),
  ('SURABAYA', 'All-in Surabaya', 'ALL-IN X PARKIR',
   'Mobil, supir, BBM, tol, dan makan supir.',
   'Parkir/tiket masuk wisata. Tip supir seikhlasnya.',
   'Juga dipakai kota lain yang belum punya tabel sendiri.', true, 4),
  ('DROP_JABODETABEK', 'Drop Only Jabodetabek', 'ALL-IN X PARKIR',
   'Mobil, supir, BBM, dan tol untuk satu tujuan.',
   'Parkir. Tip supir seikhlasnya.',
   'Usulan, perlu konfirmasi owner.', false, 5)
) AS v("code", "name", "service_package", "included", "excluded", "note", "default_for_unlisted", "sort_order")
ON CONFLICT ("code") DO NOTHING;

-- Rates: every car in every table (12H + FULLDAY; DROP for the drop table),
-- 154 rows. Prices are set per class: A Avanza sekelas, X Veloz/Xpander,
-- R Innova Reborn, Z Innova Zenix, Q Innova Zenix Q, F Fortuner/Pajero,
-- H Hiace Commuter, N ask the admin. NULL = "tanya admin". The cars outside
-- the owner's list and every Drop Only price are proposals (marked (u)).
WITH "car_class" ("slug", "cls") AS (VALUES
  ('toyota-avanza', 'A'), ('suzuki-ertiga', 'A'),
  ('mitsubishi-xpander', 'X'), ('daihatsu-terios', 'X'), ('toyota-rush', 'X'),
  ('toyota-innova-reborn', 'R'),
  ('toyota-zenix', 'Z'), ('toyota-innova-venturer', 'Z'),
  ('toyota-zenix-q-hybrid-modellista', 'Q'),
  ('toyota-fortuner', 'F'),
  ('toyota-hiace-commuter', 'H'),
  ('toyota-hiace-premio', 'N'), ('toyota-alphard', 'N'), ('isuzu-elf-long', 'N')
),
"day_price" ("zone", "cls", "h12", "fullday", "note") AS (VALUES
  ('JABODETABEK', 'A', 500000, 700000, NULL),
  ('JABODETABEK', 'X', 600000, 800000, NULL),
  ('JABODETABEK', 'R', 700000, 900000, NULL),
  ('JABODETABEK', 'Z', 1000000, 1300000, NULL),
  ('JABODETABEK', 'Q', 1400000, 1700000, NULL),
  ('JABODETABEK', 'F', 1600000, 1900000, NULL),
  ('JABODETABEK', 'H', 1500000, NULL, NULL),
  ('JABODETABEK', 'N', NULL, NULL, NULL),
  ('LUAR_KOTA', 'A', 700000, 900000, NULL),
  ('LUAR_KOTA', 'X', 800000, 1000000, NULL),
  ('LUAR_KOTA', 'R', 900000, 1100000, NULL),
  ('LUAR_KOTA', 'Z', 1200000, 1500000, NULL),
  ('LUAR_KOTA', 'Q', 1500000, 1800000, NULL),
  ('LUAR_KOTA', 'F', 1700000, 2000000, NULL),
  ('LUAR_KOTA', 'H', NULL, NULL, NULL),
  ('LUAR_KOTA', 'N', NULL, NULL, NULL),
  ('JAKARTA', 'A', 750000, 950000, NULL),
  ('JAKARTA', 'X', 850000, 1100000, NULL),
  ('JAKARTA', 'R', 1000000, 1250000, NULL),
  ('JAKARTA', 'Z', 1300000, 1600000, NULL),
  ('JAKARTA', 'Q', 1700000, 2100000, NULL),
  ('JAKARTA', 'F', NULL, NULL, 'Dibahas dengan admin'),
  ('JAKARTA', 'H', NULL, NULL, NULL),
  ('JAKARTA', 'N', NULL, NULL, NULL),
  ('BANDUNG', 'A', 850000, 1100000, NULL),
  ('BANDUNG', 'X', 950000, 1200000, NULL),
  ('BANDUNG', 'R', 1100000, 1350000, NULL),
  ('BANDUNG', 'Z', 1400000, 1700000, NULL),
  ('BANDUNG', 'Q', 1800000, 2200000, NULL),
  ('BANDUNG', 'F', NULL, NULL, 'Dibahas dengan admin'),
  ('BANDUNG', 'H', NULL, NULL, NULL),
  ('BANDUNG', 'N', NULL, NULL, NULL),
  ('SURABAYA', 'A', 850000, 1100000, NULL),
  ('SURABAYA', 'X', 950000, 1200000, NULL),
  ('SURABAYA', 'R', 1100000, 1350000, NULL),
  ('SURABAYA', 'Z', 1400000, 1700000, NULL),
  ('SURABAYA', 'Q', 1800000, 2200000, NULL),
  ('SURABAYA', 'F', NULL, NULL, 'Dibahas dengan admin'),
  ('SURABAYA', 'H', NULL, NULL, NULL),
  ('SURABAYA', 'N', NULL, NULL, NULL)
),
"drop_price" ("cls", "amount") AS (VALUES
  ('A', 500000), ('X', 600000), ('R', 700000), ('Z', 1000000),
  ('Q', 1400000), ('F', 1600000), ('H', NULL), ('N', NULL)
),
"rate" ("zone", "cls", "duration", "amount", "note") AS (
  SELECT p."zone", p."cls", d."duration", d."amount", p."note"
  FROM "day_price" p
  CROSS JOIN LATERAL (VALUES ('12H', p."h12"), ('FULLDAY', p."fullday")) AS d("duration", "amount")
  UNION ALL
  SELECT 'DROP_JABODETABEK', dp."cls", 'DROP', dp."amount", NULL
  FROM "drop_price" dp
)
INSERT INTO "price_rates" ("id", "zone_id", "car_id", "duration", "amount", "is_proposal", "note", "created_at", "updated_at")
SELECT gen_random_uuid()::text, z."id", c."id", r."duration", r."amount",
       (k."slug" IN ('suzuki-ertiga', 'daihatsu-terios', 'toyota-rush', 'toyota-innova-venturer',
                     'toyota-hiace-commuter', 'toyota-hiace-premio', 'toyota-alphard', 'isuzu-elf-long')
        OR r."duration" = 'DROP'),
       r."note", now(), now()
FROM "rate" r
JOIN "car_class" k ON k."cls" = r."cls"
JOIN "price_cars" c ON c."slug" = k."slug"
JOIN "price_zones" z ON z."code" = r."zone"
ON CONFLICT ("zone_id", "car_id", "duration") DO NOTHING;

-- Area surcharges of the all-in tables.
INSERT INTO "price_surcharges" ("id", "zone_id", "area", "amount", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid()::text, z."id", v."area", v."amount", v."sort_order", now(), now()
FROM (VALUES
  ('JAKARTA', 'Tangerang', 200000, 0),
  ('JAKARTA', 'Bekasi', 100000, 1),
  ('JAKARTA', 'Cikarang', 200000, 2),
  ('JAKARTA', 'Depok', 100000, 3),
  ('JAKARTA', 'Bogor', 100000, 4),
  ('JAKARTA', 'Puncak', 200000, 5),
  ('BANDUNG', 'Tangkuban Parahu', 100000, 0),
  ('BANDUNG', 'Ciater', 100000, 1),
  ('BANDUNG', 'Jatinangor', 100000, 2),
  ('BANDUNG', 'Pangalengan', 100000, 3),
  ('SURABAYA', 'Gresik', 200000, 0),
  ('SURABAYA', 'Sidoarjo', 150000, 1),
  ('SURABAYA', 'Prigen', 250000, 2),
  ('SURABAYA', 'Mojokerto', 250000, 3),
  ('SURABAYA', 'Kediri', 500000, 4),
  ('SURABAYA', 'Pasuruan', 400000, 5),
  ('SURABAYA', 'Malang', 400000, 6),
  ('SURABAYA', 'Bromo', 500000, 7),
  ('SURABAYA', 'Probolinggo', 500000, 8)
) AS v("zone", "area", "amount", "sort_order")
JOIN "price_zones" z ON z."code" = v."zone"
ON CONFLICT ("zone_id", "area") DO NOTHING;

-- Website city pages: which car + driver table and which all-in table they
-- show. Abroad = quote (priced per trip).
INSERT INTO "price_cities" ("id", "slug", "name", "driver_zone_id", "all_in_zone_id", "quote", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid()::text, v."slug", v."name", dz."id", az."id", v."quote", v."sort_order", now(), now()
FROM (VALUES
  ('sewa-mobil-bogor', 'Bogor', 'JABODETABEK', 'SURABAYA', false, 0),
  ('sewa-mobil-jakarta', 'Jakarta', 'JABODETABEK', 'JAKARTA', false, 1),
  ('sewa-mobil-bandung', 'Bandung', 'LUAR_KOTA', 'BANDUNG', false, 2),
  ('sewa-mobil-bekasi', 'Bekasi', 'JABODETABEK', 'SURABAYA', false, 3),
  ('sewa-mobil-depok', 'Depok', 'JABODETABEK', 'SURABAYA', false, 4),
  ('sewa-mobil-tangerang', 'Tangerang', 'JABODETABEK', 'SURABAYA', false, 5),
  ('sewa-mobil-cirebon', 'Cirebon', 'LUAR_KOTA', 'SURABAYA', false, 6),
  ('sewa-mobil-pekalongan', 'Pekalongan', 'LUAR_KOTA', 'SURABAYA', false, 7),
  ('sewa-mobil-semarang', 'Semarang', 'LUAR_KOTA', 'SURABAYA', false, 8),
  ('sewa-mobil-solo', 'Solo', 'LUAR_KOTA', 'SURABAYA', false, 9),
  ('sewa-mobil-jogja', 'Jogja', 'LUAR_KOTA', 'SURABAYA', false, 10),
  ('sewa-mobil-madiun', 'Madiun', 'LUAR_KOTA', 'SURABAYA', false, 11),
  ('sewa-mobil-surabaya', 'Surabaya', 'LUAR_KOTA', 'SURABAYA', false, 12),
  ('sewa-mobil-malang', 'Malang', 'LUAR_KOTA', 'SURABAYA', false, 13),
  ('sewa-mobil-singapura', 'Singapura', NULL, NULL, true, 14),
  ('sewa-mobil-malaysia', 'Malaysia', NULL, NULL, true, 15),
  ('sewa-mobil-thailand', 'Thailand', NULL, NULL, true, 16)
) AS v("slug", "name", "driver_zone", "all_in_zone", "quote", "sort_order")
LEFT JOIN "price_zones" dz ON dz."code" = v."driver_zone"
LEFT JOIN "price_zones" az ON az."code" = v."all_in_zone"
ON CONFLICT ("slug") DO NOTHING;

-- Driver costs and overtime.
INSERT INTO "price_extras" ("id", "code", "label", "amount", "percent", "unit", "note", "created_at", "updated_at") VALUES
  (gen_random_uuid()::text, 'DRIVER_MEAL', 'Makan supir', 100000, NULL, 'hari', 'Paket Mobil + Supir.', now(), now()),
  (gen_random_uuid()::text, 'DRIVER_LODGING', 'Inap supir', 150000, NULL, 'malam', 'Perjalanan luar kota yang menginap.', now(), now()),
  (gen_random_uuid()::text, 'OVERTIME', 'Overtime', NULL, 10, 'jam', 'Persen dari harga Fullday paket, kota, dan mobil yang sama, per jam. Berlaku bila melebihi durasi sewa atau lewat pukul 23.00.', now(), now())
ON CONFLICT ("code") DO NOTHING;
