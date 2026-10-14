-- =========================================================
-- Resep in aja — Supabase schema migration
-- =========================================================
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- Enables Row Level Security and seeds original international recipes.
--
-- NOTE: This migration was authored locally but NOT applied to any remote
-- Supabase project (no credentials were provisioned). Review before applying.
-- =========================================================

-- Extensions
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------
-- recipes
-- ---------------------------------------------------------
create table if not exists public.recipes (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    description text,
    cuisine text,
    country text,
    language text not null default 'id',
    servings integer,
    prep_minutes integer,
    cook_minutes integer,
    difficulty text,
    meal_type text,
    diet_tags text[] not null default '{}',
    allergen_tags text[] not null default '{}',
    instructions jsonb not null default '[]'::jsonb,
    image_url text,
    source_type text not null default 'curated',
    source_name text,
    source_url text,
    external_id text,
    license text,
    attribution_text text,
    verified boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_recipes_cuisine on public.recipes (cuisine);
create index if not exists idx_recipes_country on public.recipes (country);
create index if not exists idx_recipes_verified on public.recipes (verified);
create index if not exists idx_recipes_language on public.recipes (language);

-- ---------------------------------------------------------
-- ingredients
-- ---------------------------------------------------------
create table if not exists public.ingredients (
    id bigint generated always as identity primary key,
    canonical_name text unique not null,
    display_name_id text,
    display_name_en text,
    category text,
    shelf_life_category text
);

-- ---------------------------------------------------------
-- ingredient_aliases
-- ---------------------------------------------------------
create table if not exists public.ingredient_aliases (
    alias text not null,
    language text not null,
    ingredient_id bigint not null references public.ingredients(id) on delete cascade,
    primary key (alias, language)
);

create index if not exists idx_aliases_ingredient on public.ingredient_aliases (ingredient_id);

-- ---------------------------------------------------------
-- recipe_ingredients
-- ---------------------------------------------------------
create table if not exists public.recipe_ingredients (
    recipe_id uuid not null references public.recipes(id) on delete cascade,
    ingredient_id bigint not null references public.ingredients(id),
    amount numeric,
    unit text,
    preparation_note text,
    optional boolean not null default false,
    pantry_staple boolean not null default false,
    primary key (recipe_id, ingredient_id)
);

create index if not exists idx_recipe_ingredients_ingredient on public.recipe_ingredients (ingredient_id);

-- ---------------------------------------------------------
-- favorites (user-associated, RLS protected)
-- ---------------------------------------------------------
create table if not exists public.favorites (
    user_id uuid not null default auth.uid(),
    recipe_id uuid not null references public.recipes(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (user_id, recipe_id)
);

-- ---------------------------------------------------------
-- scan_history (user-associated, RLS protected)
-- ---------------------------------------------------------
create table if not exists public.scan_history (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid(),
    detected_ingredients text[] not null default '{}',
    recipe_id uuid references public.recipes(id) on delete set null,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------
alter table public.recipes enable row level security;
alter table public.ingredients enable row level security;
alter table public.ingredient_aliases enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.favorites enable row level security;
alter table public.scan_history enable row level security;

-- Anonymous (anon key) may READ only verified public recipes and their
-- ingredient/linkage tables. No anonymous writes to recipe tables.
create policy "read verified recipes" on public.recipes
    for select using (verified = true);

create policy "read ingredients" on public.ingredients
    for select using (true);

create policy "read aliases" on public.ingredient_aliases
    for select using (true);

create policy "read recipe ingredients" on public.recipe_ingredients
    for select using (true);

-- Authenticated users manage ONLY their own favorites/history.
create policy "manage own favorites" on public.favorites
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "manage own scan history" on public.scan_history
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------
-- Trigger to keep updated_at fresh
-- ---------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_recipes_updated_at on public.recipes;
create trigger trg_recipes_updated_at
    before update on public.recipes
    for each row execute function public.set_updated_at();

-- =========================================================
-- SEED DATA — original international recipes (CC0)
-- =========================================================
-- Only factual metadata + original instructions. No copyrighted content.
-- Image fields left empty (no copyrighted images).

do $$
declare
    rid uuid;
    iid bigint;
begin
    -- Nasi Goreng Sisa Kulkas (Indonesian)
    insert into public.recipes (
        title, description, cuisine, country, language, servings,
        prep_minutes, cook_minutes, difficulty, meal_type, diet_tags,
        allergen_tags, instructions, source_type, source_name, external_id,
        license, attribution_text, verified
    ) values (
        'Nasi Goreng Sisa Kulkas', 'Nasi goreng sederhana dari nasi sisa, telur, dan sayuran apa pun yang ada.',
        'Indonesian', 'Indonesia', 'id', 2, 5, 15, 'easy', 'main',
        '{}', '{egg,soy}',
        '["Panaskan minyak, tumis bawang putih dan bawang merah sampai harum.","Masukkan telur, orak-arik sampai setengah matang.","Masukkan nasi dingin, aduk dengan kecap manis dan garam.","Tambahkan sayuran dan masak 3 menit, sajikan hangat."]'::jsonb,
        'curated', 'Resep in aja (original)', 'seed-nasi-goreng', 'CC0-1.0',
        'Resep asli Resep in aja, lisensi CC0.', true
    ) returning id into rid;

    foreach iid in array (select id from public.ingredients where canonical_name in ('rice','egg','garlic','shallot','sweet soy sauce','salt','oil'))
    loop
        insert into public.recipe_ingredients (recipe_id, ingredient_id, optional, pantry_staple)
        values (rid, iid, false, false);
    end loop;
end $$;

-- Remaining seed recipes are represented fully in seed_data.py and can be
-- loaded with the provided helper script; see README "Adding legally sourced
-- recipes". The single-row example above demonstrates the insert pattern.
