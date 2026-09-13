# Meu Financeiro

App de finanças pessoais feito em React Native + Expo. Roda no celular (Android/iOS) e também como site (Expo Web).

## Rodando localmente

```
npm install
npm run web
```

## Publicação (site)

Este projeto está preparado para ser publicado assim:

- **Código-fonte:** GitHub (este repositório)
- **Hospedagem do site:** Vercel, importando este repositório
  - Comando de build: `npx expo export -p web`
  - Pasta de saída: `dist`
  - (Essas duas configurações já estão em `vercel.json`, a Vercel detecta sozinha)
- **Domínio:** domínio próprio registrado na Hostgator, apontado para a Vercel
- **Banco de dados e login:** Supabase (ver `supabase-schema.sql`)
- **Envio de e-mails (confirmação de cadastro, redefinição de senha):** Resend, configurado como SMTP do Supabase Auth

## Banco de dados (Supabase)

O arquivo `supabase-schema.sql` contém todas as tabelas e as regras de segurança
(Row Level Security) necessárias. Para usar:

1. Crie um projeto em [supabase.com](https://supabase.com)
2. Vá em **SQL Editor** no menu da esquerda
3. Cole todo o conteúdo de `supabase-schema.sql` e clique em **Run**
4. Copie a **Project URL** e a **publishable key** (em *Project Settings → API Keys*)
   e coloque num arquivo `.env` na raiz (veja `.env.example`):

```
EXPO_PUBLIC_SUPABASE_URL=https://SEU-PROJETO.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

As mesmas duas variáveis precisam estar cadastradas na Vercel
(*Settings → Environment Variables*), senão o site publicado não consegue
falar com o Supabase. O `.env` **não** vai pro Git (está no `.gitignore`).

## Login e e-mails

O login é obrigatório: sem conta, o app só mostra a tela de entrar/cadastrar.
Cada pessoa só enxerga as próprias linhas no banco (é o RLS que garante isso).

Configurações que precisam estar certas no painel do Supabase:

- **Authentication → URL Configuration → Site URL:** o endereço do site
  publicado (ex: `https://www.pimble.com.br`). Se ficar em `localhost`, os
  links dos e-mails não funcionam.
- **Authentication → Sign In / Providers:** *Confirm email* ligado.
- **Authentication → Emails → SMTP Settings:** usando o Resend —
  host `smtp.resend.com`, porta `465`, usuário `resend`, senha = uma API key
  do Resend, e o remetente num domínio verificado lá (ex:
  `nao-responda@pimble.com.br`).

No Resend, o domínio precisa estar **Verified**, o que exige 4 registros de DNS
(DKIM, dois CNAMEs de envio e o DMARC) cadastrados em quem controla o DNS do
domínio — no nosso caso, a Hostgator.

## Tema e idioma

Preferências de tema (claro/escuro) e idioma continuam salvas só no aparelho
de cada pessoa (não fazem parte da conta/login).
