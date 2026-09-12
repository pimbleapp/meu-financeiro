-- ============================================================
-- Meu Financeiro — esquema do banco de dados (Supabase / Postgres)
-- ============================================================
-- Como usar: entre no seu projeto em supabase.com, vá em
-- "SQL Editor" (menu da esquerda), cole TODO este arquivo,
-- e clique em "Run". Só precisa fazer isso uma vez.
--
-- Cada tabela guarda os dados de TODOS os usuários juntos, mas o
-- "Row Level Security" (RLS) garante que cada pessoa só consegue
-- ler/gravar/apagar as próprias linhas — nunca as de outra conta.
-- ============================================================

-- ---------- TRANSAÇÕES ----------
create table if not exists public.transacoes (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  titulo text not null,
  valor numeric not null,
  tipo text not null check (tipo in ('entrada', 'saida')),
  data_iso date not null,
  compra_parcelada_id text,
  criado_em timestamptz not null default now()
);
alter table public.transacoes enable row level security;
create policy "usuario_ve_suas_transacoes" on public.transacoes
  for select using (auth.uid() = user_id);
create policy "usuario_insere_suas_transacoes" on public.transacoes
  for insert with check (auth.uid() = user_id);
create policy "usuario_atualiza_suas_transacoes" on public.transacoes
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "usuario_apaga_suas_transacoes" on public.transacoes
  for delete using (auth.uid() = user_id);
create index if not exists transacoes_user_id_idx on public.transacoes (user_id);

-- ---------- CONTAS FIXAS ----------
create table if not exists public.contas_fixas (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  titulo text not null,
  valor numeric not null,
  tipo text not null check (tipo in ('entrada', 'saida')),
  dia_do_mes int not null,
  ultimo_mes_confirmado text,
  transacao_confirmada_id text,
  criado_em timestamptz not null default now()
);
alter table public.contas_fixas enable row level security;
create policy "usuario_ve_suas_contas_fixas" on public.contas_fixas
  for select using (auth.uid() = user_id);
create policy "usuario_insere_suas_contas_fixas" on public.contas_fixas
  for insert with check (auth.uid() = user_id);
create policy "usuario_atualiza_suas_contas_fixas" on public.contas_fixas
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "usuario_apaga_suas_contas_fixas" on public.contas_fixas
  for delete using (auth.uid() = user_id);
create index if not exists contas_fixas_user_id_idx on public.contas_fixas (user_id);

-- ---------- DÍVIDAS ----------
create table if not exists public.dividas (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  nome text not null,
  saldo_devedor numeric not null,
  taxa_juros_mensal numeric not null,
  parcela_minima numeric not null,
  numero_parcelas int,
  parcelas_pagas int not null default 0,
  ultimo_mes_confirmado text,
  transacao_confirmada_id text,
  saldo_antes_ultima_parcela numeric,
  criado_em timestamptz not null default now()
);
alter table public.dividas enable row level security;
create policy "usuario_ve_suas_dividas" on public.dividas
  for select using (auth.uid() = user_id);
create policy "usuario_insere_suas_dividas" on public.dividas
  for insert with check (auth.uid() = user_id);
create policy "usuario_atualiza_suas_dividas" on public.dividas
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "usuario_apaga_suas_dividas" on public.dividas
  for delete using (auth.uid() = user_id);
create index if not exists dividas_user_id_idx on public.dividas (user_id);

-- ---------- INVESTIMENTOS ----------
create table if not exists public.investimentos (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  nome text not null,
  tipo text not null,
  valor_investido numeric not null,
  valor_atual numeric not null,
  criado_em timestamptz not null default now()
);
alter table public.investimentos enable row level security;
create policy "usuario_ve_seus_investimentos" on public.investimentos
  for select using (auth.uid() = user_id);
create policy "usuario_insere_seus_investimentos" on public.investimentos
  for insert with check (auth.uid() = user_id);
create policy "usuario_atualiza_seus_investimentos" on public.investimentos
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "usuario_apaga_seus_investimentos" on public.investimentos
  for delete using (auth.uid() = user_id);
create index if not exists investimentos_user_id_idx on public.investimentos (user_id);

-- ---------- METAS DE ECONOMIA ----------
create table if not exists public.metas (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  nome text not null,
  valor_alvo numeric not null,
  valor_atual numeric not null,
  data_alvo date,
  criado_em timestamptz not null default now()
);
alter table public.metas enable row level security;
create policy "usuario_ve_suas_metas" on public.metas
  for select using (auth.uid() = user_id);
create policy "usuario_insere_suas_metas" on public.metas
  for insert with check (auth.uid() = user_id);
create policy "usuario_atualiza_suas_metas" on public.metas
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "usuario_apaga_suas_metas" on public.metas
  for delete using (auth.uid() = user_id);
create index if not exists metas_user_id_idx on public.metas (user_id);

-- ---------- SEQUÊNCIA ("sem estourar o mês") ----------
-- Uma linha só por usuário (por isso o id é o próprio user_id).
create table if not exists public.streak (
  user_id uuid primary key references auth.users (id) on delete cascade,
  streak_atual int not null default 0,
  melhor_streak int not null default 0,
  dia_registrado date,
  status_mais_recente text,
  atualizado_em timestamptz not null default now()
);
alter table public.streak enable row level security;
create policy "usuario_ve_seu_streak" on public.streak
  for select using (auth.uid() = user_id);
create policy "usuario_insere_seu_streak" on public.streak
  for insert with check (auth.uid() = user_id);
create policy "usuario_atualiza_seu_streak" on public.streak
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "usuario_apaga_seu_streak" on public.streak
  for delete using (auth.uid() = user_id);

-- ============================================================
-- Pronto! Depois de rodar isso uma vez, o banco já está pronto
-- pro app usar. Tema (claro/escuro) e Idioma continuam guardados
-- só no aparelho de cada um (não precisam de conta pra isso).
-- ============================================================
