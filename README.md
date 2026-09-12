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
4. Copie a **Project URL** e a **anon public key** (em *Project Settings → API*)
   e coloque nas variáveis de ambiente do projeto (veja `.env.example`, quando existir)

## Tema e idioma

Preferências de tema (claro/escuro) e idioma continuam salvas só no aparelho
de cada pessoa (não fazem parte da conta/login).
