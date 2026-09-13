// lib/supabase.js
// Cliente único do Supabase, usado em todo o app pra login/cadastro
// (Supabase Auth) e pra ler/gravar os dados de cada usuário (Postgres).
//
// "react-native-url-polyfill/auto" precisa ser importado ANTES de
// qualquer outra coisa aqui, porque o supabase-js depende de APIs de URL
// que não existem por padrão no ambiente do React Native.
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Isso só deveria acontecer se o arquivo .env estiver faltando ou mal
  // configurado — avisa no console pra ficar fácil de descobrir o motivo
  // caso o login/cadastro pare de funcionar.
  console.warn(
    'Supabase: faltam as variáveis de ambiente EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY.'
  );
}

// "storage: AsyncStorage" é o que faz a sessão de login continuar salva
// entre uma abertura do app e outra (sem isso, a pessoa teria que entrar
// de novo toda vez).
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // No site, os links que chegam por e-mail (confirmar cadastro e
    // redefinir senha) voltam pro app com um código na própria URL — isso
    // aqui é o que faz o Supabase ler esse código e abrir a sessão. No
    // celular não existe URL, então fica desligado.
    detectSessionInUrl: Platform.OS === 'web',
  },
});
