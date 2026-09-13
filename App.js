// App.js
// App financeiro com foco em quitação de dívidas, feito com React Native + Expo.
// Este arquivo é um exemplo para quem está começando: os comentários
// explicam o que cada parte do código faz.
//
// O app tem 2 abas (feitas "na mão", sem biblioteca de navegação, pra manter
// as coisas simples): "Início" (resumo financeiro) e "Dívidas" (o módulo
// novo, com estratégias Avalanche e Bola de Neve).

import React, { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  View,
  Text,
  FlatList,
  SectionList,
  ScrollView,
  StyleSheet,
  Platform,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from './lib/supabase';

// ============================================================
// AVISOS E CONFIRMAÇÕES (funcionam no celular E no site)
// ============================================================
// No celular, o React Native tem o "Alert.alert" pronto. Só que na
// versão web ele simplesmente não faz nada — os avisos de erro e as
// perguntas de "tem certeza?" sumiriam sem ninguém ver.
//
// Pra resolver, o app inteiro chama "avisar(...)" no lugar de
// "Alert.alert(...)". No celular ela usa o alerta nativo; no site ela
// abre um modal do próprio app (ver "ProvedorDeAvisos" lá embaixo, que
// é quem registra a função nessa variável aqui).
let _abrirAvisoNaTela = null;

function avisar(titulo, mensagem, botoes) {
  if (Platform.OS === 'web' && _abrirAvisoNaTela) {
    _abrirAvisoNaTela({ titulo, mensagem, botoes: botoes || null });
    return;
  }
  Alert.alert(titulo, mensagem, botoes);
}

// ============================================================
// FUNÇÕES AUXILIARES (usadas em várias partes do app)
// ============================================================

// Formata um número como moeda brasileira (R$)
function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

// Converte o texto digitado pelo usuário (que pode ter vírgula) em número.
// Ex: "1.234,56" digitado como "1234,56" vira 1234.56
function paraNumero(texto) {
  const numero = parseFloat(String(texto).replace(',', '.'));
  return isNaN(numero) ? 0 : numero;
}

// Arredonda pra 2 casas decimais, evitando aquelas dízimas de ponto
// flutuante tipo 199.99999999998 depois de várias contas.
function arredondar2(valor) {
  return Math.round(valor * 100) / 100;
}

// Divide uma compra em N parcelas iguais (a última absorve a sobra de
// centavos, pra soma bater certinho com o valor original), uma por mês
// a partir da data escolhida. Usada tanto pra lançar de verdade quanto
// pra gerar a prévia antes de salvar.
function gerarParcelasFuturas(valor, totalParcelas, dataBase, idCompra) {
  const valorParcela = arredondar2(valor / totalParcelas);
  const somaParcelasIniciais = arredondar2(valorParcela * (totalParcelas - 1));
  const valorUltimaParcela = arredondar2(valor - somaParcelasIniciais);

  const parcelas = [];
  for (let i = 0; i < totalParcelas; i++) {
    const dataDaParcela = new Date(dataBase.getFullYear(), dataBase.getMonth() + i, dataBase.getDate());
    parcelas.push({
      numero: i + 1,
      valor: i === totalParcelas - 1 ? valorUltimaParcela : valorParcela,
      data: dataParaBR(dataDaParcela),
      dataISO: dataParaISO(dataDaParcela),
      compraParceladaId: idCompra,
    });
  }
  return parcelas;
}

// "Prévia da parcela": pra cada mês das parcelas futuras, estima se aquele
// mês vai ficar apertado, olhando a renda esperada (contas fixas de
// entrada) contra o que já tá comprometido (contas fixas de saída +
// parcelas de dívidas ativas + outras compras parceladas que caiam no
// mesmo mês + a parcela nova).
function calcularPreviaParcelamento(parcelas, { contasFixas, dividasAtivas, transacoesExistentes }) {
  const rendaFixaMensal = contasFixas
    .filter((c) => c.tipo === 'entrada')
    .reduce((soma, c) => soma + c.valor, 0);
  const saidasFixasMensal = contasFixas
    .filter((c) => c.tipo === 'saida')
    .reduce((soma, c) => soma + c.valor, 0);
  const parcelasDividasMensal = dividasAtivas.reduce((soma, d) => soma + d.parcelaMinima, 0);

  const resultadosPorMes = parcelas.map((parcela) => {
    const chaveMes = parcela.dataISO.slice(0, 7);
    const outrasParcelasFantasmaNoMes = transacoesExistentes
      .filter((t) => t.compraParceladaId && t.dataISO.slice(0, 7) === chaveMes)
      .reduce((soma, t) => soma + t.valor, 0);

    const comprometido = arredondar2(
      saidasFixasMensal + parcelasDividasMensal + outrasParcelasFantasmaNoMes + parcela.valor
    );

    let status = 'verde';
    if (rendaFixaMensal <= 0) {
      status = comprometido > 0 ? 'vermelho' : 'verde';
    } else if (comprometido >= rendaFixaMensal) {
      status = 'vermelho';
    } else if (comprometido >= rendaFixaMensal * 0.7) {
      status = 'amarelo';
    }

    return { chaveMes, valorParcela: parcela.valor, status };
  });

  return { resultadosPorMes, rendaFixaMensal };
}

// Uma dívida é considerada quitada quando o saldo já chegou a zero, OU
// quando ela tinha um número fixo de parcelas e todas já foram pagas.
function dividaEstaQuitada(divida) {
  if (divida.saldoDevedor <= 0.01) return true;
  if (divida.numeroParcelas > 0 && divida.parcelasPagas >= divida.numeroParcelas) return true;
  return false;
}

// Migração: dívidas salvas antes dos campos de parcelamento existirem não
// têm "numeroParcelas", "parcelasPagas" etc. Essa função preenche o que
// falta com valores neutros, pra não travar nada no resto do app.
function comCamposDivida(divida) {
  return {
    numeroParcelas: 0,
    parcelasPagas: 0,
    ultimoMesConfirmado: null,
    transacaoConfirmadaId: null,
    saldoAntesUltimaParcela: null,
    ...divida,
  };
}

const NOMES_MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// ============================================================
// INVESTIMENTOS — tipos, cores da alocação e o comparador
// "investir ou quitar dívida primeiro?"
// ============================================================

// Categorias fixas pra classificar cada investimento. "Reserva de
// Emergência" é tratada de um jeito especial: é ela que conta pra meta
// de reserva lá embaixo.
const TIPOS_INVESTIMENTO = [
  'Reserva de Emergência',
  'Renda Fixa',
  'Ações',
  'Fundos Imobiliários',
  'Cripto',
  'Outro',
];

// Traduz o "tipo" de um investimento pra exibir na tela. O valor
// GUARDADO (ex: "Reserva de Emergência") continua sempre em português,
// porque é ele que é salvo e comparado no código (calcularReservaEmergencia
// etc) — só a exibição muda com o idioma, senão dados salvos antes de
// existir tradução parariam de bater.
function traduzirTipoInvestimento(tipo, t) {
  return t(`investimentos.tipoLabel.${tipo}`);
}

// Cada tipo recebe sempre a mesma cor (na ordem de TIPOS_INVESTIMENTO),
// só que usando os tokens do tema atual — assim funciona certinho no
// claro e no escuro.
function corDoTipoInvestimento(tipo, cores) {
  const paleta = [cores.primario, cores.verde, cores.laranjaForte, cores.ambar, cores.vermelho, cores.textoSecundario];
  const indice = TIPOS_INVESTIMENTO.indexOf(tipo);
  return paleta[indice >= 0 ? indice % paleta.length : paleta.length - 1];
}

// Junta valor investido, valor atual e como está dividido por tipo —
// usado pro resumo lá em cima da tela e pro gráfico de alocação.
function calcularResumoInvestimentos(investimentos) {
  const totalInvestido = arredondar2(investimentos.reduce((s, i) => s + i.valorInvestido, 0));
  const totalAtual = arredondar2(investimentos.reduce((s, i) => s + i.valorAtual, 0));
  const rendimentoValor = arredondar2(totalAtual - totalInvestido);
  const rendimentoPercentual = totalInvestido > 0 ? arredondar2((rendimentoValor / totalInvestido) * 100) : 0;

  const porTipo = {};
  investimentos.forEach((i) => {
    porTipo[i.tipo] = (porTipo[i.tipo] || 0) + i.valorAtual;
  });
  const alocacao = Object.keys(porTipo)
    .map((tipo) => ({
      tipo,
      valorAtual: arredondar2(porTipo[tipo]),
      percentual: totalAtual > 0 ? arredondar2((porTipo[tipo] / totalAtual) * 100) : 0,
    }))
    .sort((a, b) => b.valorAtual - a.valorAtual);

  return { totalInvestido, totalAtual, rendimentoValor, rendimentoPercentual, alocacao };
}

// A recomendação clássica de reserva de emergência é ter de 3 a 6 meses
// das despesas fixas guardados. Aqui a meta usa 6 meses (o lado mais
// seguro), calculada em cima das contas fixas de saída cadastradas na
// aba Início.
function calcularReservaEmergencia(investimentos, contasFixas) {
  const gastosFixosMensais = arredondar2(
    contasFixas.filter((c) => c.tipo === 'saida').reduce((s, c) => s + c.valor, 0)
  );
  const metaReserva = arredondar2(gastosFixosMensais * 6);
  const valorReserva = arredondar2(
    investimentos.filter((i) => i.tipo === 'Reserva de Emergência').reduce((s, i) => s + i.valorAtual, 0)
  );
  const progresso = metaReserva > 0 ? Math.min(100, arredondar2((valorReserva / metaReserva) * 100)) : 0;
  return { gastosFixosMensais, metaReserva, valorReserva, progresso };
}

// Metas de economia — diferente da reserva de emergência (que é uma meta
// fixa e automática), essas são metas livres que você cria ("juntar
// R$3000 pra uma viagem"), com um valor atual que você mesmo atualiza.
// Se tiver uma data alvo, calcula quanto guardar por mês pra chegar lá.
function calcularMeta(meta, hoje) {
  const progresso =
    meta.valorAlvo > 0 ? Math.min(100, arredondar2((meta.valorAtual / meta.valorAlvo) * 100)) : 0;
  const faltam = arredondar2(Math.max(0, meta.valorAlvo - meta.valorAtual));
  const atingida = meta.valorAlvo > 0 && meta.valorAtual >= meta.valorAlvo;

  let mesesRestantes = null;
  let valorMensalNecessario = null;
  if (!atingida && meta.dataAlvo) {
    const hojeMes = hoje.getFullYear() * 12 + hoje.getMonth();
    const [anoAlvo, mesAlvo] = meta.dataAlvo.slice(0, 7).split('-').map(Number);
    const dataAlvoMes = anoAlvo * 12 + (mesAlvo - 1);
    // Trava em no mínimo 1 mês, pra não dividir por zero (ou virar negativo)
    // quando a data alvo já é esse mês ou já passou.
    mesesRestantes = Math.max(1, dataAlvoMes - hojeMes);
    valorMensalNecessario = arredondar2(faltam / mesesRestantes);
  }

  return { progresso, faltam, atingida, mesesRestantes, valorMensalNecessario };
}

// O "pulo do gato": a taxa de juros das dívidas nesse app é mensal, mas
// as pessoas pensam em retorno de investimento "ao ano". Essa função
// converte a taxa mensal da dívida pra uma taxa anual composta, pra dar
// pra comparar as duas coisas de igual pra igual.
function calcularComparadorInvestDivida(taxaJurosMensal, taxaAnualInvestimento) {
  const taxaAnualDivida = arredondar2((Math.pow(1 + taxaJurosMensal / 100, 12) - 1) * 100);
  const diferenca = arredondar2(taxaAnualDivida - taxaAnualInvestimento);
  return {
    taxaAnualDivida,
    diferenca,
    vantagemQuitar: taxaAnualDivida > taxaAnualInvestimento,
  };
}

// Simulador de futuro/aposentadoria: projeta quanto o que você já tem
// investido, mais um aporte mensal fixo, pode virar depois de X anos,
// rendendo uma taxa composta ao ano. É a fórmula clássica de valor futuro
// com aportes (juros compostos mês a mês).
const HORIZONTES_SIMULACAO_FUTURO = [5, 10, 20, 30];

function calcularSimulacaoFuturo(valorInicial, aporteMensal, taxaAnualPercent, anos) {
  const i = Math.pow(1 + taxaAnualPercent / 100, 1 / 12) - 1;
  const n = anos * 12;
  let valorFinal;
  if (i === 0) {
    valorFinal = valorInicial + aporteMensal * n;
  } else {
    valorFinal = valorInicial * Math.pow(1 + i, n) + aporteMensal * ((Math.pow(1 + i, n) - 1) / i);
  }
  return arredondar2(valorFinal);
}

// Sempre com 2 dígitos: 3 -> "03", 12 -> "12"
function doisDigitos(numero) {
  return String(numero).padStart(2, '0');
}

// Transforma um objeto Date em texto "AAAA-MM-DD" (fácil de comparar/ordenar)
function dataParaISO(data) {
  return `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
}

// O contrário de dataParaISO: transforma "AAAA-MM-DD" de volta num objeto
// Date. Monta com ano/mês/dia separados (em vez de "new Date(textoISO)")
// de propósito, pra não cair no fuso horário errado.
function dataISOParaData(dataISO) {
  const [ano, mes, dia] = dataISO.slice(0, 10).split('-').map(Number);
  return new Date(ano, mes - 1, dia);
}

// Transforma um objeto Date em texto "DD/MM/AAAA" (fácil de mostrar na tela)
function dataParaBR(data) {
  return `${doisDigitos(data.getDate())}/${doisDigitos(data.getMonth() + 1)}/${data.getFullYear()}`;
}

// Calendário pra escolher uma data: no celular usa o @react-native-community/datetimepicker
// de sempre; no navegador (versão site do app) esse componente nativo não
// existe, então usamos o calendário que o próprio navegador já sabe mostrar
// (um <input type="date">). O "onChange" continua com a mesma cara nos dois
// casos — (evento, dataEscolhida) — pra não precisar mudar nada de quem usa.
function SeletorDeData({ value, onChange }) {
  if (Platform.OS === 'web') {
    return React.createElement('input', {
      type: 'date',
      value: dataParaISO(value),
      onChange: (evento) => {
        const textoISO = evento && evento.target ? evento.target.value : '';
        if (!textoISO) return;
        onChange(evento, dataISOParaData(textoISO));
      },
      style: {
        fontSize: 14,
        padding: 10,
        borderRadius: 8,
        border: '1px solid #ccc',
        marginTop: -6,
        marginBottom: 12,
        fontFamily: 'inherit',
      },
    });
  }
  return (
    <DateTimePicker value={value} mode="date" display={Platform.OS === 'ios' ? 'spinner' : 'default'} onChange={onChange} />
  );
}

// Migração: transações salvas antes dessa atualização não têm o campo
// "dataISO" (só tinham "data" em texto "DD/MM/AAAA"). Essa função preenche
// esse campo que falta, pra não travar a ordenação/agrupamento por mês.
function comDataISO(transacao) {
  if (transacao.dataISO) return transacao;
  const [dia, mes, ano] = transacao.data.split('/');
  return { ...transacao, dataISO: `${ano}-${mes}-${dia}` };
}

// Agrupa as transações por mês, já ordenadas da mais recente pra mais
// antiga — pronto pro formato que o SectionList espera.
function agruparTransacoesPorMes(transacoes, t) {
  const ordenadas = [...transacoes].sort((a, b) => {
    if (a.dataISO !== b.dataISO) return a.dataISO < b.dataISO ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });

  const grupos = [];
  ordenadas.forEach((transacao) => {
    const chaveMes = transacao.dataISO.slice(0, 7); // "AAAA-MM"
    let grupo = grupos.find((g) => g.chaveMes === chaveMes);
    if (!grupo) {
      const [ano, mes] = chaveMes.split('-');
      grupo = {
        chaveMes,
        title: t('comum.mesDeAno', { mes: t(`comum.meses.${parseInt(mes, 10) - 1}`), ano }),
        data: [],
      };
      grupos.push(grupo);
    }
    grupo.data.push(transacao);
  });
  return grupos;
}

// ============================================================
// ABA 1: INÍCIO — resumo financeiro simples
// ============================================================

// ============================================================
// SUPABASE — sincronização por usuário (substitui o antigo AsyncStorage
// pra esses 6 "domínios" financeiros: cada pessoa só lê/grava as próprias
// linhas, graças ao RLS já configurado em supabase-schema.sql). Tema e
// idioma continuam guardados só no aparelho — ver CHAVE_ARMAZENAMENTO_TEMA
// e CHAVE_ARMAZENAMENTO_IDIOMA lá embaixo, essas duas não mudam.
// ============================================================

// Nomes das tabelas no Postgres (iguais aos de supabase-schema.sql)
const TABELA_TRANSACOES = 'transacoes';
const TABELA_CONTAS_FIXAS = 'contas_fixas';
const TABELA_DIVIDAS = 'dividas';
const TABELA_STREAK = 'streak';
const TABELA_INVESTIMENTOS = 'investimentos';
const TABELA_METAS = 'metas';

// Busca todas as linhas de uma tabela pertencentes a esse usuário e já
// converte cada uma de snake_case (formato do banco) pra camelCase
// (formato usado no resto do app), usando o conversor passado.
async function buscarLinhasDoUsuario(tabela, userId, linhaParaObjeto) {
  const { data, error } = await supabase.from(tabela).select('*').eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(linhaParaObjeto);
}

// "Salva" uma lista inteira (array de objetos em camelCase) numa tabela:
// grava/atualiza (upsert) cada item, e apaga do banco qualquer linha
// desse usuário que não esteja mais na lista (por exemplo, depois de
// remover uma transação ou uma dívida). Como esse app é de uso pessoal
// (dezenas/poucas centenas de linhas), fazer upsert + apagar as que
// sobraram é simples e rápido o suficiente, sem precisar controlar cada
// alteração individualmente.
async function sincronizarLinhasDoUsuario(tabela, userId, itens, objetoParaLinha) {
  if (itens.length > 0) {
    const linhas = itens.map((item) => objetoParaLinha(item, userId));
    const { error: erroUpsert } = await supabase.from(tabela).upsert(linhas, { onConflict: 'id' });
    if (erroUpsert) throw erroUpsert;
  }

  const { data: linhasExistentes, error: erroSelect } = await supabase
    .from(tabela)
    .select('id')
    .eq('user_id', userId);
  if (erroSelect) throw erroSelect;

  const idsAtuais = new Set(itens.map((item) => item.id));
  const idsParaApagar = (linhasExistentes || [])
    .map((linha) => linha.id)
    .filter((id) => !idsAtuais.has(id));

  if (idsParaApagar.length > 0) {
    const { error: erroDelete } = await supabase
      .from(tabela)
      .delete()
      .eq('user_id', userId)
      .in('id', idsParaApagar);
    if (erroDelete) throw erroDelete;
  }
}

// ---------- Conversores de campos: transações ----------
function transacaoParaLinha(transacao, userId) {
  return {
    id: transacao.id,
    user_id: userId,
    titulo: transacao.titulo,
    valor: transacao.valor,
    tipo: transacao.tipo,
    data_iso: transacao.dataISO,
    compra_parcelada_id: transacao.compraParceladaId || null,
  };
}
function linhaParaTransacao(linha) {
  const dataISO = linha.data_iso;
  return {
    id: linha.id,
    titulo: linha.titulo,
    valor: Number(linha.valor),
    tipo: linha.tipo,
    // "data" (DD/MM/AAAA) não é salva no banco — reconstruída aqui a
    // partir de "dataISO" pra continuar aparecendo igual na tela.
    data: dataParaBR(dataISOParaData(dataISO)),
    dataISO,
    compraParceladaId: linha.compra_parcelada_id || null,
  };
}

// ---------- Conversores de campos: contas fixas ----------
function contaFixaParaLinha(contaFixa, userId) {
  return {
    id: contaFixa.id,
    user_id: userId,
    titulo: contaFixa.titulo,
    valor: contaFixa.valor,
    tipo: contaFixa.tipo,
    dia_do_mes: contaFixa.diaDoMes,
    ultimo_mes_confirmado: contaFixa.ultimoMesConfirmado || null,
    transacao_confirmada_id: contaFixa.transacaoConfirmadaId || null,
  };
}
function linhaParaContaFixa(linha) {
  return {
    id: linha.id,
    titulo: linha.titulo,
    valor: Number(linha.valor),
    tipo: linha.tipo,
    diaDoMes: linha.dia_do_mes,
    ultimoMesConfirmado: linha.ultimo_mes_confirmado || null,
    transacaoConfirmadaId: linha.transacao_confirmada_id || null,
  };
}

// ---------- Conversores de campos: dívidas ----------
function dividaParaLinha(divida, userId) {
  return {
    id: divida.id,
    user_id: userId,
    nome: divida.nome,
    saldo_devedor: divida.saldoDevedor,
    taxa_juros_mensal: divida.taxaJurosMensal,
    parcela_minima: divida.parcelaMinima,
    numero_parcelas: divida.numeroParcelas || null,
    parcelas_pagas: divida.parcelasPagas || 0,
    ultimo_mes_confirmado: divida.ultimoMesConfirmado || null,
    transacao_confirmada_id: divida.transacaoConfirmadaId || null,
    saldo_antes_ultima_parcela:
      divida.saldoAntesUltimaParcela === null || divida.saldoAntesUltimaParcela === undefined
        ? null
        : divida.saldoAntesUltimaParcela,
  };
}
function linhaParaDivida(linha) {
  return comCamposDivida({
    id: linha.id,
    nome: linha.nome,
    saldoDevedor: Number(linha.saldo_devedor),
    taxaJurosMensal: Number(linha.taxa_juros_mensal),
    parcelaMinima: Number(linha.parcela_minima),
    numeroParcelas: linha.numero_parcelas || 0,
    parcelasPagas: linha.parcelas_pagas || 0,
    ultimoMesConfirmado: linha.ultimo_mes_confirmado || null,
    transacaoConfirmadaId: linha.transacao_confirmada_id || null,
    saldoAntesUltimaParcela:
      linha.saldo_antes_ultima_parcela === null || linha.saldo_antes_ultima_parcela === undefined
        ? null
        : Number(linha.saldo_antes_ultima_parcela),
  });
}

// ---------- Conversores de campos: investimentos ----------
function investimentoParaLinha(investimento, userId) {
  return {
    id: investimento.id,
    user_id: userId,
    nome: investimento.nome,
    tipo: investimento.tipo,
    valor_investido: investimento.valorInvestido,
    valor_atual: investimento.valorAtual,
  };
}
function linhaParaInvestimento(linha) {
  return {
    id: linha.id,
    nome: linha.nome,
    tipo: linha.tipo,
    valorInvestido: Number(linha.valor_investido),
    valorAtual: Number(linha.valor_atual),
  };
}

// ---------- Conversores de campos: metas de economia ----------
function metaParaLinha(meta, userId) {
  return {
    id: meta.id,
    user_id: userId,
    nome: meta.nome,
    valor_alvo: meta.valorAlvo,
    valor_atual: meta.valorAtual,
    data_alvo: meta.dataAlvo || null,
  };
}
function linhaParaMeta(linha) {
  return {
    id: linha.id,
    nome: linha.nome,
    valorAlvo: Number(linha.valor_alvo),
    valorAtual: Number(linha.valor_atual),
    dataAlvo: linha.data_alvo || null,
  };
}

// ---------- Sequência ("streak") — uma linha só por usuário ----------
async function buscarStreakDoUsuario(userId) {
  const { data, error } = await supabase
    .from(TABELA_STREAK)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    streakAtual: data.streak_atual,
    melhorStreak: data.melhor_streak,
    diaRegistrado: data.dia_registrado,
    statusMaisRecente: data.status_mais_recente,
  };
}
async function salvarStreakDoUsuario(userId, streakData) {
  const { error } = await supabase.from(TABELA_STREAK).upsert(
    {
      user_id: userId,
      streak_atual: streakData.streakAtual,
      melhor_streak: streakData.melhorStreak,
      dia_registrado: streakData.diaRegistrado,
      status_mais_recente: streakData.statusMaisRecente,
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}

// Volta um dia a partir de uma data "AAAA-MM-DD" (cuida sozinho da virada
// de mês/ano, por causa de como o objeto Date funciona).
function diaAnterior(dataISO) {
  const [ano, mes, dia] = dataISO.split('-').map(Number);
  const data = new Date(ano, mes - 1, dia);
  data.setDate(data.getDate() - 1);
  return dataParaISO(data);
}

// "Máquina do Tempo": olha só pra meses JÁ FECHADOS (antes do mês atual),
// pega no máximo os 3 últimos, e tira a média de quanto sobrou (ou faltou)
// por mês. É essa média que usamos pra projetar os próximos meses.
function calcularProjecaoFinanceira(transacoes, mesAtualChave) {
  const porMes = {};
  transacoes.forEach((t) => {
    const chaveMes = t.dataISO.slice(0, 7);
    if (chaveMes >= mesAtualChave) return; // ignora o mês atual (incompleto) e qualquer data futura
    if (!porMes[chaveMes]) porMes[chaveMes] = { entradas: 0, saidas: 0 };
    if (t.tipo === 'entrada') porMes[chaveMes].entradas += t.valor;
    else porMes[chaveMes].saidas += t.valor;
  });

  const chavesOrdenadas = Object.keys(porMes).sort().reverse(); // mais recente primeiro
  const ultimasChaves = chavesOrdenadas.slice(0, 3);
  if (ultimasChaves.length === 0) return null;

  const somaNet = ultimasChaves.reduce(
    (soma, chave) => soma + (porMes[chave].entradas - porMes[chave].saidas),
    0
  );

  return {
    mediaMensal: arredondar2(somaNet / ultimasChaves.length),
    mesesConsiderados: ultimasChaves.length,
  };
}

// "Posso comprar isso?" — simula, sem salvar nada, o que aconteceria com o
// semáforo do "quanto posso gastar hoje" se você fizesse essa compra à
// vista agora. Usa a mesma conta do semáforo de verdade, só que descontando
// o valor da compra antes de calcular o status.
function calcularImpactoCompra(valorCompra, { saldoLivreHoje, diasRestantesNoMes, mediaGastoDiarioAteAgora }) {
  const novoSaldoLivreHoje = arredondar2(saldoLivreHoje - valorCompra);
  const novoGastoDiarioSeguro = arredondar2(novoSaldoLivreHoje / Math.max(1, diasRestantesNoMes));
  let novoStatus = 'verde';
  if (novoSaldoLivreHoje <= 0) novoStatus = 'vermelho';
  else if (novoGastoDiarioSeguro < mediaGastoDiarioAteAgora) novoStatus = 'amarelo';
  return { novoSaldoLivreHoje, novoGastoDiarioSeguro, novoStatus };
}

// "Alerta de mês estranho" — compara o quanto você já gastou esse mês (até
// hoje) com a média do que você gastava, até o MESMO dia do mês, nos
// últimos meses fechados. Se a diferença for grande (pra mais ou pra
// menos), avisa — sem precisar você ficar comparando na mão.
function calcularAlertaMesEstranho(transacoesJaOcorridas, mesAtualChave, diaDeHoje) {
  const porMes = {};
  transacoesJaOcorridas.forEach((t) => {
    if (t.tipo !== 'saida') return;
    const chaveMes = t.dataISO.slice(0, 7);
    if (chaveMes >= mesAtualChave) return; // só meses já fechados
    const dia = parseInt(t.dataISO.slice(8, 10), 10);
    if (dia > diaDeHoje) return; // compara só até o mesmo "dia do mês" de hoje
    porMes[chaveMes] = (porMes[chaveMes] || 0) + t.valor;
  });

  const chavesOrdenadas = Object.keys(porMes).sort().reverse();
  const ultimasChaves = chavesOrdenadas.slice(0, 3);
  if (ultimasChaves.length === 0) return null; // sem histórico ainda, não dá pra comparar

  const totalSaidasMesAtualAteHoje = arredondar2(
    transacoesJaOcorridas
      .filter((t) => t.tipo === 'saida' && t.dataISO.slice(0, 7) === mesAtualChave)
      .reduce((s, t) => s + t.valor, 0)
  );

  const somaMedia = ultimasChaves.reduce((soma, chave) => soma + porMes[chave], 0);
  const mediaComparavel = arredondar2(somaMedia / ultimasChaves.length);
  if (mediaComparavel <= 0) return null;

  const percentualDiferenca = arredondar2(
    ((totalSaidasMesAtualAteHoje - mediaComparavel) / mediaComparavel) * 100
  );

  if (percentualDiferenca >= 30) {
    return {
      tipo: 'alto',
      percentualDiferenca,
      mediaComparavel,
      totalSaidasMesAtualAteHoje,
      mesesConsiderados: ultimasChaves.length,
    };
  }
  if (percentualDiferenca <= -30) {
    return {
      tipo: 'baixo',
      percentualDiferenca,
      mediaComparavel,
      totalSaidasMesAtualAteHoje,
      mesesConsiderados: ultimasChaves.length,
    };
  }
  return null;
}

function TelaInicio() {
  const { estilos: styles, cores } = useTema();
  const { t } = useIdioma();
  const { user } = useAuth();
  const userId = user.id;
  const [transacoes, setTransacoes] = useState([]);
  const [carregandoTransacoes, setCarregandoTransacoes] = useState(true);
  const [modalVisivel, setModalVisivel] = useState(false);

  // Campos do formulário de nova transação
  const [novoTitulo, setNovoTitulo] = useState('');
  const [novoValor, setNovoValor] = useState('');
  const [novoTipo, setNovoTipo] = useState('entrada');
  const [dataSelecionada, setDataSelecionada] = useState(new Date());
  const [mostrarSeletorData, setMostrarSeletorData] = useState(false);
  // "Compra fantasma": se marcado, lança várias parcelas futuras de uma vez
  const [compraParcelada, setCompraParcelada] = useState(false);
  const [numeroParcelasCompra, setNumeroParcelasCompra] = useState('');

  // "Posso comprar isso?" — calculadora rápida (à vista ou parcelada), só
  // pra testar o impacto de uma compra sem precisar lançar a transação de
  // verdade
  const [valorTesteCompra, setValorTesteCompra] = useState('');
  const [testeParcelado, setTesteParcelado] = useState(false);
  const [testeNumeroParcelas, setTesteNumeroParcelas] = useState('');

  // "Sequência sem estourar" — conta os dias seguidos que o semáforo do dia
  // não ficou vermelho. "diaRegistrado" é o último dia que a gente conferiu,
  // e "statusMaisRecente" guarda o status mais atual desse dia (vai sendo
  // atualizado se você abrir o app de novo no mesmo dia); só quando o dia
  // vira de verdade é que esse status conta (ou não) pra sequência.
  const [streakData, setStreakData] = useState({
    streakAtual: 0,
    melhorStreak: 0,
    diaRegistrado: null,
    statusMaisRecente: null,
  });
  const [carregandoStreak, setCarregandoStreak] = useState(true);

  // Contas fixas (salário, aluguel...) que se repetem todo mês
  const [contasFixas, setContasFixas] = useState([]);
  const [carregandoContasFixas, setCarregandoContasFixas] = useState(true);
  const [modalContaFixaVisivel, setModalContaFixaVisivel] = useState(false);
  const [novoTituloFixa, setNovoTituloFixa] = useState('');
  const [novoValorFixa, setNovoValorFixa] = useState('');
  const [novoDiaFixa, setNovoDiaFixa] = useState('');
  const [novoTipoFixa, setNovoTipoFixa] = useState('entrada');
  // Quando não é null, o modal está EDITANDO essa conta fixa (em vez de criar uma nova)
  const [contaFixaEditandoId, setContaFixaEditandoId] = useState(null);
  // Status desse mês, só usado quando está editando: true = já recebido/pago
  const [statusRecebidoEditando, setStatusRecebidoEditando] = useState(false);

  // Dívidas cadastradas na aba Dívidas — carregadas aqui também só pra
  // mostrar a parcela de cada uma e deixar confirmar o pagamento do mês
  // direto por aqui (edição completa continua lá na aba Dívidas).
  const [dividas, setDividas] = useState([]);
  const [carregandoDividas, setCarregandoDividas] = useState(true);

  // Carrega as transações salvas (no Supabase, só as desse usuário) assim
  // que a tela abre
  useEffect(() => {
    async function carregarTransacoesSalvas() {
      try {
        const transacoesCarregadas = await buscarLinhasDoUsuario(TABELA_TRANSACOES, userId, linhaParaTransacao);
        setTransacoes(transacoesCarregadas.map(comDataISO));
      } catch (erro) {
        console.log('Não foi possível carregar as transações salvas:', erro);
      } finally {
        setCarregandoTransacoes(false);
      }
    }
    carregarTransacoesSalvas();
  }, [userId]);

  // Salva de novo toda vez que a lista de transações mudar
  useEffect(() => {
    if (carregandoTransacoes) return;
    sincronizarLinhasDoUsuario(TABELA_TRANSACOES, userId, transacoes, transacaoParaLinha).catch((erro) => {
      console.log('Não foi possível salvar as transações:', erro);
    });
  }, [transacoes, carregandoTransacoes, userId]);

  // Carrega as contas fixas salvas
  useEffect(() => {
    async function carregarContasFixasSalvas() {
      try {
        const contasCarregadas = await buscarLinhasDoUsuario(TABELA_CONTAS_FIXAS, userId, linhaParaContaFixa);
        setContasFixas(contasCarregadas);
      } catch (erro) {
        console.log('Não foi possível carregar as contas fixas salvas:', erro);
      } finally {
        setCarregandoContasFixas(false);
      }
    }
    carregarContasFixasSalvas();
  }, [userId]);

  // Salva de novo toda vez que a lista de contas fixas mudar
  useEffect(() => {
    if (carregandoContasFixas) return;
    sincronizarLinhasDoUsuario(TABELA_CONTAS_FIXAS, userId, contasFixas, contaFixaParaLinha).catch((erro) => {
      console.log('Não foi possível salvar as contas fixas:', erro);
    });
  }, [contasFixas, carregandoContasFixas, userId]);

  // Carrega as dívidas salvas (a mesma tabela que a aba Dívidas usa)
  useEffect(() => {
    async function carregarDividasSalvas() {
      try {
        const dividasCarregadas = await buscarLinhasDoUsuario(TABELA_DIVIDAS, userId, linhaParaDivida);
        setDividas(dividasCarregadas);
      } catch (erro) {
        console.log('Não foi possível carregar as dívidas salvas:', erro);
      } finally {
        setCarregandoDividas(false);
      }
    }
    carregarDividasSalvas();
  }, [userId]);

  // Salva de novo toda vez que a lista de dívidas mudar (por causa da
  // confirmação de parcela, feita aqui na tela de Início)
  useEffect(() => {
    if (carregandoDividas) return;
    sincronizarLinhasDoUsuario(TABELA_DIVIDAS, userId, dividas, dividaParaLinha).catch((erro) => {
      console.log('Não foi possível salvar as dívidas:', erro);
    });
  }, [dividas, carregandoDividas, userId]);

  // Carrega a sequência salva (a lógica que atualiza ela mesma fica lá
  // embaixo, depois que o status do semáforo de hoje já foi calculado)
  useEffect(() => {
    async function carregarStreakSalva() {
      try {
        const streakCarregada = await buscarStreakDoUsuario(userId);
        if (streakCarregada !== null) {
          setStreakData(streakCarregada);
        }
      } catch (erro) {
        console.log('Não foi possível carregar a sequência salva:', erro);
      } finally {
        setCarregandoStreak(false);
      }
    }
    carregarStreakSalva();
  }, [userId]);

  // Os totais são calculados de verdade, a partir de TODAS as transações
  // (o Saldo Total é o acumulado geral, não só do mês)
  const hoje = new Date();
  const mesAtualChave = dataParaISO(hoje).slice(0, 7); // "AAAA-MM"
  const hojeISO = dataParaISO(hoje);
  const diaDeHoje = hoje.getDate();

  // IMPORTANTE: só contam transações com data até HOJE. Isso existe por
  // causa das "compras fantasmas" parceladas (parcelas futuras já aparecem
  // no histórico, mas só devem afetar o saldo quando a data delas chegar —
  // senão o saldo cairia inteiro de uma vez no dia da compra).
  const transacoesJaOcorridas = transacoes.filter((t) => t.dataISO <= hojeISO);

  // O Saldo Total é o acumulado de TODAS as transações já ocorridas, desde
  // sempre (por isso ele "carrega" o que sobrou do mês anterior, em vez de
  // zerar)
  const totalEntradasGeral = transacoesJaOcorridas
    .filter((t) => t.tipo === 'entrada')
    .reduce((soma, t) => soma + t.valor, 0);
  const totalSaidasGeral = transacoesJaOcorridas
    .filter((t) => t.tipo === 'saida')
    .reduce((soma, t) => soma + t.valor, 0);
  const saldoTotal = totalEntradasGeral - totalSaidasGeral;

  // Já os cards de Entradas/Saídas mostram só o mês atual, e voltam a
  // zerar quando o mês vira
  const totalEntradas = transacoesJaOcorridas
    .filter((t) => t.tipo === 'entrada' && t.dataISO.slice(0, 7) === mesAtualChave)
    .reduce((soma, t) => soma + t.valor, 0);
  const totalSaidas = transacoesJaOcorridas
    .filter((t) => t.tipo === 'saida' && t.dataISO.slice(0, 7) === mesAtualChave)
    .reduce((soma, t) => soma + t.valor, 0);

  // Descobre quais contas fixas já "venceram" esse mês e ainda não foram
  // confirmadas (pra mostrar o aviso de pendência)
  const contasFixasPendentes = contasFixas.filter(
    (c) => c.ultimoMesConfirmado !== mesAtualChave && diaDeHoje >= c.diaDoMes
  );

  // Dívidas ainda não quitadas — são elas que mostram a parcela por aqui
  const dividasAtivas = dividas.filter((d) => !dividaEstaQuitada(d));

  // ---- Prévia da compra parcelada (antes de salvar) ----
  const totalParcelasPreview = parseInt(numeroParcelasCompra, 10);
  const mostrarPreviaParcelamento =
    novoTipo === 'saida' && compraParcelada && totalParcelasPreview >= 2 && paraNumero(novoValor) > 0;
  const previaParcelamento = mostrarPreviaParcelamento
    ? calcularPreviaParcelamento(
        gerarParcelasFuturas(paraNumero(novoValor), totalParcelasPreview, dataSelecionada),
        { contasFixas, dividasAtivas, transacoesExistentes: transacoes }
      )
    : null;

  // ---- "Quanto posso gastar hoje" ----
  // Pega o que sobrou esse mês e desconta os compromissos que ainda vão
  // sair (contas fixas e parcelas de dívidas não confirmadas), depois
  // divide pelos dias que faltam pro mês acabar.
  const diasNoMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const diasRestantesNoMes = diasNoMes - diaDeHoje + 1;
  const saidasFixasPendentesValor = contasFixas
    .filter((c) => c.tipo === 'saida' && c.ultimoMesConfirmado !== mesAtualChave)
    .reduce((soma, c) => soma + c.valor, 0);
  const parcelasDividasPendentesValor = dividasAtivas
    .filter((d) => d.ultimoMesConfirmado !== mesAtualChave)
    .reduce((soma, d) => soma + d.parcelaMinima, 0);
  const saldoLivreHoje = arredondar2(
    totalEntradas - totalSaidas - saidasFixasPendentesValor - parcelasDividasPendentesValor
  );
  const gastoDiarioSeguro = arredondar2(saldoLivreHoje / Math.max(1, diasRestantesNoMes));
  const mediaGastoDiarioAteAgora = diaDeHoje > 0 ? totalSaidas / diaDeHoje : 0;

  let statusGastoDiario = 'verde';
  if (saldoLivreHoje <= 0) {
    statusGastoDiario = 'vermelho';
  } else if (gastoDiarioSeguro < mediaGastoDiarioAteAgora) {
    statusGastoDiario = 'amarelo';
  }

  // ---- "Posso comprar isso?" ----
  const valorCompraTeste = paraNumero(valorTesteCompra);
  const impactoCompra =
    !testeParcelado && valorCompraTeste > 0
      ? calcularImpactoCompra(valorCompraTeste, { saldoLivreHoje, diasRestantesNoMes, mediaGastoDiarioAteAgora })
      : null;

  // Mesma prévia mês a mês usada no formulário de nova transação parcelada,
  // só que aqui é só pra testar, sem lançar nada de verdade.
  const totalParcelasTeste = parseInt(testeNumeroParcelas, 10);
  const previaTesteCompra =
    testeParcelado && valorCompraTeste > 0 && totalParcelasTeste >= 2
      ? calcularPreviaParcelamento(gerarParcelasFuturas(valorCompraTeste, totalParcelasTeste, hoje), {
          contasFixas,
          dividasAtivas,
          transacoesExistentes: transacoes,
        })
      : null;

  // Atualiza a "Sequência sem estourar" sempre que o dia ou o status mudar.
  // Enquanto ainda é o mesmo dia já registrado, só atualiza qual foi o
  // status mais recente (pode mudar se você gastar mais ao longo do dia).
  // Quando o dia vira, aí sim fecha o dia anterior: se ele não tinha virado
  // vermelho E é literalmente "ontem" (sem pular dias), soma 1 na sequência;
  // senão, zera.
  useEffect(() => {
    if (carregandoStreak) return;
    setStreakData((atual) => {
      if (atual.diaRegistrado === hojeISO) {
        if (atual.statusMaisRecente === statusGastoDiario) return atual;
        return { ...atual, statusMaisRecente: statusGastoDiario };
      }
      let novoStreakAtual;
      if (atual.diaRegistrado === null) {
        novoStreakAtual = 0;
      } else if (atual.diaRegistrado === diaAnterior(hojeISO) && atual.statusMaisRecente !== 'vermelho') {
        novoStreakAtual = atual.streakAtual + 1;
      } else {
        novoStreakAtual = 0;
      }
      return {
        streakAtual: novoStreakAtual,
        melhorStreak: Math.max(atual.melhorStreak, novoStreakAtual),
        diaRegistrado: hojeISO,
        statusMaisRecente: statusGastoDiario,
      };
    });
  }, [hojeISO, statusGastoDiario, carregandoStreak]);

  // Salva a sequência sempre que ela mudar
  useEffect(() => {
    if (carregandoStreak) return;
    salvarStreakDoUsuario(userId, streakData).catch((erro) => {
      console.log('Não foi possível salvar a sequência:', erro);
    });
  }, [streakData, carregandoStreak, userId]);

  // ---- "Alerta de mês estranho" ----
  const alertaMesEstranho = calcularAlertaMesEstranho(transacoesJaOcorridas, mesAtualChave, diaDeHoje);

  // ---- "Máquina do Tempo" ----
  // Projeta o saldo lá na frente com base na média dos últimos meses.
  const projecaoFinanceira = calcularProjecaoFinanceira(transacoesJaOcorridas, mesAtualChave);
  const saldoProjetado3Meses = projecaoFinanceira
    ? arredondar2(saldoTotal + projecaoFinanceira.mediaMensal * 3)
    : null;
  const saldoProjetado6Meses = projecaoFinanceira
    ? arredondar2(saldoTotal + projecaoFinanceira.mediaMensal * 6)
    : null;

  // Agrupa as transações por mês, pra mostrar separadores no histórico
  // (inclui as futuras também, pra dar pra ver as parcelas que ainda vêm)
  const secoesTransacoes = agruparTransacoesPorMes(transacoes, t);

  function confirmarRemocao(id) {
    avisar(t('inicio.confirmarRemocaoTransacaoTitulo'), t('inicio.confirmarRemocaoTransacaoMensagem'), [
      { text: t('comum.cancelar'), style: 'cancel' },
      {
        text: t('comum.remover'),
        style: 'destructive',
        onPress: () => setTransacoes((atual) => atual.filter((transacao) => transacao.id !== id)),
      },
    ]);
  }

  function limparFormulario() {
    setNovoTitulo('');
    setNovoValor('');
    setNovoTipo('entrada');
    setDataSelecionada(new Date());
    setCompraParcelada(false);
    setNumeroParcelasCompra('');
  }

  function salvarNovaTransacao() {
    const valor = paraNumero(novoValor);

    if (!novoTitulo.trim()) {
      avisar(t('comum.ops'), t('inicio.erroDescricao'));
      return;
    }
    if (valor <= 0) {
      avisar(t('comum.ops'), t('inicio.erroValor'));
      return;
    }

    const usarParcelamento = novoTipo === 'saida' && compraParcelada;
    const totalParcelas = usarParcelamento ? parseInt(numeroParcelasCompra, 10) : 1;

    if (usarParcelamento && (!totalParcelas || totalParcelas < 2)) {
      avisar(t('comum.ops'), t('inicio.erroNumeroParcelasCompra'));
      return;
    }

    if (!usarParcelamento || totalParcelas === 1) {
      // Transação normal, à vista
      const novaTransacao = {
        id: Date.now().toString(),
        titulo: novoTitulo.trim(),
        valor,
        tipo: novoTipo,
        data: dataParaBR(dataSelecionada),
        dataISO: dataParaISO(dataSelecionada),
      };
      setTransacoes((atual) => [novaTransacao, ...atual]);
    } else {
      // "Compra fantasma": já lança TODAS as parcelas de uma vez, cada uma
      // no mês certo lá na frente. Elas aparecem no histórico desde já,
      // mas só entram no saldo quando a data de cada uma chegar (por causa
      // do filtro "transacoesJaOcorridas" lá em cima).
      const idCompra = Date.now().toString();
      const parcelasGeradas = gerarParcelasFuturas(valor, totalParcelas, dataSelecionada, idCompra);
      const novasParcelas = parcelasGeradas.map((p) => ({
        id: `${idCompra}-${p.numero}`,
        titulo: `${novoTitulo.trim()} (${p.numero}/${totalParcelas})`,
        valor: p.valor,
        tipo: 'saida',
        data: p.data,
        dataISO: p.dataISO,
        compraParceladaId: p.compraParceladaId,
      }));
      setTransacoes((atual) => [...novasParcelas, ...atual]);
    }

    limparFormulario();
    setModalVisivel(false);
  }

  // Chamado quando o usuário escolhe uma data no calendário
  function aoMudarData(evento, dataEscolhida) {
    setMostrarSeletorData(false); // no Android o calendário some sozinho
    if (dataEscolhida) {
      setDataSelecionada(dataEscolhida);
    }
  }

  function limparFormularioContaFixa() {
    setNovoTituloFixa('');
    setNovoValorFixa('');
    setNovoDiaFixa('');
    setNovoTipoFixa('entrada');
    setContaFixaEditandoId(null);
    setStatusRecebidoEditando(false);
  }

  // Abre o modal já preenchido com os dados da conta fixa, pra editar
  function abrirEdicaoContaFixa(contaFixa) {
    setContaFixaEditandoId(contaFixa.id);
    setNovoTituloFixa(contaFixa.titulo);
    setNovoValorFixa(String(contaFixa.valor));
    setNovoDiaFixa(String(contaFixa.diaDoMes));
    setNovoTipoFixa(contaFixa.tipo);
    setStatusRecebidoEditando(contaFixa.ultimoMesConfirmado === mesAtualChave);
    setModalContaFixaVisivel(true);
  }

  function salvarContaFixa() {
    const valor = paraNumero(novoValorFixa);
    const dia = parseInt(novoDiaFixa, 10);

    if (!novoTituloFixa.trim()) {
      avisar(t('comum.ops'), t('inicio.erroNomeContaFixa'));
      return;
    }
    if (valor <= 0) {
      avisar(t('comum.ops'), t('inicio.erroValor'));
      return;
    }
    if (!dia || dia < 1 || dia > 28) {
      avisar(t('comum.ops'), t('inicio.erroDiaContaFixa'));
      return;
    }

    if (contaFixaEditandoId) {
      // Editando uma conta fixa que já existia
      const contaOriginal = contasFixas.find((c) => c.id === contaFixaEditandoId);
      const jaEstavaConfirmadaEsseMes = contaOriginal && contaOriginal.ultimoMesConfirmado === mesAtualChave;
      let idTransacaoConfirmada = contaOriginal ? contaOriginal.transacaoConfirmadaId : null;

      if (statusRecebidoEditando && !jaEstavaConfirmadaEsseMes) {
        // Passou a ser confirmada agora: lança a transação desse mês
        const dataLancamento = new Date(hoje.getFullYear(), hoje.getMonth(), dia);
        idTransacaoConfirmada = Date.now().toString();
        const novaTransacao = {
          id: idTransacaoConfirmada,
          titulo: novoTituloFixa.trim(),
          valor,
          tipo: novoTipoFixa,
          data: dataParaBR(dataLancamento),
          dataISO: dataParaISO(dataLancamento),
        };
        setTransacoes((atual) => [novaTransacao, ...atual]);
      } else if (!statusRecebidoEditando && jaEstavaConfirmadaEsseMes) {
        // Deixou de ser confirmada: remove a transação que tinha sido lançada
        if (idTransacaoConfirmada) {
          setTransacoes((atual) => atual.filter((t) => t.id !== idTransacaoConfirmada));
        }
        idTransacaoConfirmada = null;
      }

      setContasFixas((atual) =>
        atual.map((c) => {
          if (c.id !== contaFixaEditandoId) return c;
          return {
            ...c,
            titulo: novoTituloFixa.trim(),
            valor,
            tipo: novoTipoFixa,
            diaDoMes: dia,
            ultimoMesConfirmado: statusRecebidoEditando ? mesAtualChave : null,
            transacaoConfirmadaId: idTransacaoConfirmada,
          };
        })
      );
    } else {
      // Criando uma conta fixa nova
      const novaContaFixa = {
        id: Date.now().toString(),
        titulo: novoTituloFixa.trim(),
        valor,
        tipo: novoTipoFixa,
        diaDoMes: dia,
        ultimoMesConfirmado: null, // ainda não foi lançada em nenhum mês
        transacaoConfirmadaId: null,
      };
      setContasFixas((atual) => [...atual, novaContaFixa]);
    }

    limparFormularioContaFixa();
    setModalContaFixaVisivel(false);
  }

  function removerContaFixa(id) {
    avisar(
      t('inicio.confirmarRemocaoContaFixaTitulo'),
      t('inicio.confirmarRemocaoContaFixaMensagem'),
      [
        { text: t('comum.cancelar'), style: 'cancel' },
        {
          text: t('comum.remover'),
          style: 'destructive',
          onPress: () => setContasFixas((atual) => atual.filter((c) => c.id !== id)),
        },
      ]
    );
  }

  // Lança de verdade a transação referente a uma conta fixa confirmada
  // Confirma o recebimento/pagamento: lança a transação desse mês E guarda
  // o id dela na própria conta fixa (em "transacaoConfirmadaId"), pra dar
  // pra desfazer com precisão depois — sem isso, marcar/desmarcar repetido
  // ia criar uma transação nova a cada clique, sem nunca remover nenhuma.
  function confirmarContaFixa(contaFixa) {
    const dataLancamento = new Date(hoje.getFullYear(), hoje.getMonth(), contaFixa.diaDoMes);
    const idNovaTransacao = Date.now().toString();

    const novaTransacao = {
      id: idNovaTransacao,
      titulo: contaFixa.titulo,
      valor: contaFixa.valor,
      tipo: contaFixa.tipo,
      data: dataParaBR(dataLancamento),
      dataISO: dataParaISO(dataLancamento),
    };

    setTransacoes((atual) => [novaTransacao, ...atual]);
    setContasFixas((atual) =>
      atual.map((c) =>
        c.id === contaFixa.id
          ? { ...c, ultimoMesConfirmado: mesAtualChave, transacaoConfirmadaId: idNovaTransacao }
          : c
      )
    );
  }

  // Desfaz a confirmação: remove EXATAMENTE a transação que tinha sido
  // lançada por ela (guardada em transacaoConfirmadaId), sem apagar
  // nenhuma outra transação por engano.
  function desconfirmarContaFixa(contaFixa) {
    if (contaFixa.transacaoConfirmadaId) {
      setTransacoes((atual) => atual.filter((t) => t.id !== contaFixa.transacaoConfirmadaId));
    }
    setContasFixas((atual) =>
      atual.map((c) =>
        c.id === contaFixa.id ? { ...c, ultimoMesConfirmado: null, transacaoConfirmadaId: null } : c
      )
    );
  }

  // Botão rápido, direto no card: alterna entre "confirmado" e "pendente"
  // sem precisar abrir o modal de edição.
  function alternarConfirmacaoContaFixa(contaFixa) {
    const estaConfirmada = contaFixa.ultimoMesConfirmado === mesAtualChave;
    if (estaConfirmada) {
      desconfirmarContaFixa(contaFixa);
    } else {
      confirmarContaFixa(contaFixa);
    }
  }

  // Confirma o pagamento da parcela desse mês: lança a saída na transações
  // E já amortiza a dívida (aplica os juros do mês e desconta o valor da
  // parcela do saldo devedor), igual à simulação da aba Dívidas faz.
  // Guarda o saldo de antes em "saldoAntesUltimaParcela" pra dar pra
  // desfazer com precisão, sem depender de "reverter" a conta dos juros.
  function confirmarParcelaDivida(divida) {
    const juros = divida.saldoDevedor * (divida.taxaJurosMensal / 100);
    const novoSaldo = Math.max(0, arredondar2(divida.saldoDevedor + juros - divida.parcelaMinima));
    const idNovaTransacao = Date.now().toString();

    const novaTransacao = {
      id: idNovaTransacao,
      titulo: `Parcela - ${divida.nome}`,
      valor: divida.parcelaMinima,
      tipo: 'saida',
      data: dataParaBR(hoje),
      dataISO: dataParaISO(hoje),
    };

    setTransacoes((atual) => [novaTransacao, ...atual]);
    setDividas((atual) =>
      atual.map((d) =>
        d.id === divida.id
          ? {
              ...d,
              saldoAntesUltimaParcela: d.saldoDevedor,
              saldoDevedor: novoSaldo,
              parcelasPagas: (d.parcelasPagas || 0) + 1,
              ultimoMesConfirmado: mesAtualChave,
              transacaoConfirmadaId: idNovaTransacao,
            }
          : d
      )
    );
  }

  // Desfaz a confirmação: remove a transação lançada e devolve o saldo
  // devedor pro valor de antes da parcela (guardado em saldoAntesUltimaParcela).
  function desconfirmarParcelaDivida(divida) {
    if (divida.transacaoConfirmadaId) {
      setTransacoes((atual) => atual.filter((t) => t.id !== divida.transacaoConfirmadaId));
    }
    setDividas((atual) =>
      atual.map((d) => {
        if (d.id !== divida.id) return d;
        const saldoRestaurado =
          d.saldoAntesUltimaParcela !== null && d.saldoAntesUltimaParcela !== undefined
            ? d.saldoAntesUltimaParcela
            : d.saldoDevedor;
        return {
          ...d,
          saldoDevedor: saldoRestaurado,
          parcelasPagas: Math.max(0, (d.parcelasPagas || 0) - 1),
          ultimoMesConfirmado: null,
          transacaoConfirmadaId: null,
          saldoAntesUltimaParcela: null,
        };
      })
    );
  }

  // Botão rápido, direto no card: alterna entre "parcela paga" e "pendente"
  function alternarConfirmacaoParcelaDivida(divida) {
    const estaConfirmada = divida.ultimoMesConfirmado === mesAtualChave;
    if (estaConfirmada) {
      desconfirmarParcelaDivida(divida);
    } else {
      confirmarParcelaDivida(divida);
    }
  }

  const renderTransacao = ({ item }) => {
    const ehFutura = item.dataISO > hojeISO;
    return (
      <View style={[styles.transactionItem, ehFutura && styles.transactionItemFutura]}>
        <View style={styles.transactionIconWrapper}>
          <Ionicons
            name={item.tipo === 'entrada' ? 'arrow-up' : 'arrow-down'}
            size={18}
            color={item.tipo === 'entrada' ? cores.verde : cores.vermelho}
          />
        </View>
        <View style={styles.transactionInfo}>
          <Text style={styles.transactionTitle}>{item.titulo}</Text>
          <Text style={styles.transactionDate}>
            {item.data}
            {ehFutura ? ` · 🔜 ${t('inicio.aindaNaoEntrouNoSaldo')}` : ''}
          </Text>
        </View>
        <Text
          style={[
            styles.transactionValue,
            { color: item.tipo === 'entrada' ? cores.verde : cores.vermelho },
          ]}
        >
          {item.tipo === 'entrada' ? '+ ' : '- '}
          {formatarMoeda(item.valor)}
        </Text>
        <TouchableOpacity
          onPress={() => confirmarRemocao(item.id)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ marginLeft: 8 }}
        >
          <Ionicons name="trash-outline" size={18} color={cores.textoMuted} />
        </TouchableOpacity>
      </View>
    );
  };

  // IMPORTANTE: isso é uma VARIÁVEL com um elemento JSX pronto, não uma
  // função-componente. Se fosse "const ListaVazia = () => (...)", uma
  // função NOVA seria criada a cada vez que a tela renderiza (por
  // exemplo, a cada letra digitada em qualquer campo), e o React trataria
  // isso como um componente diferente — destruindo e recriando tudo que
  // tem dentro, inclusive o foco de campos de texto. Guardando como uma
  // variável comum, o "tipo" do elemento continua sendo sempre <View>,
  // então o React não recria a árvore à toa.
  const listaVaziaElemento = (
    <View style={styles.emptyContainer}>
      <Ionicons name="receipt-outline" size={48} color={cores.textoMuted} />
      <Text style={styles.emptyTitle}>{t('inicio.vazioTitulo')}</Text>
      <Text style={styles.emptySubtitle}>{t('inicio.vazioSubtitulo')}</Text>
    </View>
  );

  // Mesmo motivo do comentário acima: isso PRECISA ser um elemento pronto,
  // não uma função-componente, senão os campos "Posso comprar isso?" (e
  // qualquer outro campo aqui dentro) perdem o foco a cada tecla digitada.
  const cabecalhoElemento = (
    <View>
      <Text style={styles.headerTitle}>{t('inicio.nomeApp')}</Text>
      <Text style={styles.headerSubtitle}>{t('inicio.resumoDaConta')}</Text>

      <View style={styles.balanceCard}>
        <View style={styles.balanceIconWrapper}>
          <Ionicons name="wallet" size={22} color={cores.branco} />
        </View>
        <Text style={styles.balanceLabel}>{t('inicio.saldoTotal')}</Text>
        <Text style={styles.balanceValue}>{formatarMoeda(saldoTotal)}</Text>
      </View>

      <View style={styles.row}>
        <View style={[styles.smallCard, styles.incomeCard]}>
          <View style={styles.smallCardHeader}>
            <Ionicons name="arrow-up-circle" size={20} color={cores.verde} />
            <Text style={styles.smallCardLabel}>{t('inicio.entradas')}</Text>
          </View>
          <Text style={[styles.smallCardValue, { color: cores.verdeTextoForte }]}>
            {formatarMoeda(totalEntradas)}
          </Text>
          <Text style={styles.smallCardPeriodo}>{t('inicio.esteMes')}</Text>
        </View>

        <View style={[styles.smallCard, styles.expenseCard]}>
          <View style={styles.smallCardHeader}>
            <Ionicons name="arrow-down-circle" size={20} color={cores.vermelho} />
            <Text style={styles.smallCardLabel}>{t('inicio.saidas')}</Text>
          </View>
          <Text style={[styles.smallCardValue, { color: cores.vermelhoTextoForte }]}>
            {formatarMoeda(totalSaidas)}
          </Text>
          <Text style={styles.smallCardPeriodo}>{t('inicio.esteMes')}</Text>
        </View>
      </View>

      {/* "Quanto posso gastar hoje": pega o que sobra dividido pelos dias
          que faltam pro mês acabar, já descontando contas fixas e parcelas
          de dívidas que ainda vão sair. Um semáforo simples de ritmo de gasto. */}
      <View
        style={[
          styles.dailyBudgetCard,
          statusGastoDiario === 'verde' && styles.dailyBudgetCardVerde,
          statusGastoDiario === 'amarelo' && styles.dailyBudgetCardAmarelo,
          statusGastoDiario === 'vermelho' && styles.dailyBudgetCardVermelho,
        ]}
      >
        <Text style={styles.dailyBudgetLabel}>{t('inicio.quantoPossoGastarHoje')}</Text>
        <Text style={styles.dailyBudgetValue}>
          {saldoLivreHoje <= 0 ? t('inicio.jaEstourouOMes') : formatarMoeda(gastoDiarioSeguro)}
        </Text>
        <Text style={styles.dailyBudgetSubtitle}>
          {statusGastoDiario === 'verde' && t('inicio.gastoDiarioVerde')}
          {statusGastoDiario === 'amarelo' && t('inicio.gastoDiarioAmarelo')}
          {statusGastoDiario === 'vermelho' && t('inicio.gastoDiarioVermelho')}
        </Text>
      </View>

      {/* "Alerta de mês estranho": compara o que você já gastou esse mês
          (até hoje) com a média do que gastava até o mesmo dia, nos últimos
          meses. Só aparece quando a diferença é grande o suficiente pra
          valer a pena avisar. */}
      {alertaMesEstranho && (
        <View
          style={[
            styles.alertaMesCard,
            alertaMesEstranho.tipo === 'alto' ? styles.alertaMesCardAlto : styles.alertaMesCardBaixo,
          ]}
        >
          <Ionicons
            name={alertaMesEstranho.tipo === 'alto' ? 'warning' : 'happy-outline'}
            size={22}
            color={alertaMesEstranho.tipo === 'alto' ? cores.vermelho : cores.verde}
          />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text
              style={[
                styles.alertaMesTitulo,
                { color: alertaMesEstranho.tipo === 'alto' ? cores.vermelhoTextoForte : cores.verdeTextoForte },
              ]}
            >
              {alertaMesEstranho.tipo === 'alto' ? t('inicio.mesForaPadraoMais') : t('inicio.mesForaPadraoMenos')}
            </Text>
            <Text
              style={[
                styles.alertaMesSubtitulo,
                { color: alertaMesEstranho.tipo === 'alto' ? cores.vermelhoTextoForte : cores.verdeTextoForte },
              ]}
            >
              {alertaMesEstranho.tipo === 'alto'
                ? t('inicio.alertaMesTextoMais', {
                    total: formatarMoeda(alertaMesEstranho.totalSaidasMesAtualAteHoje),
                    percentual: Math.abs(alertaMesEstranho.percentualDiferenca).toLocaleString('pt-BR'),
                    media: formatarMoeda(alertaMesEstranho.mediaComparavel),
                  })
                : t('inicio.alertaMesTextoMenos', {
                    total: formatarMoeda(alertaMesEstranho.totalSaidasMesAtualAteHoje),
                    percentual: Math.abs(alertaMesEstranho.percentualDiferenca).toLocaleString('pt-BR'),
                  })}
            </Text>
          </View>
        </View>
      )}

      {/* "Posso comprar isso?": testa o impacto de uma compra (à vista ou
          parcelada) antes de decidir, sem precisar lançar a transação de
          verdade. */}
      <Text style={styles.sectionTitle}>{t('inicio.possoComprarIssoTitulo')}</Text>
      <Text style={styles.helperText}>{t('inicio.possoComprarIssoHelper')}</Text>
      <TextInput
        style={styles.input}
        value={valorTesteCompra}
        onChangeText={setValorTesteCompra}
        keyboardType="decimal-pad"
        placeholder={t('inicio.placeholderValorCompra')}
      />

      <View style={styles.segmentedControl}>
        <TouchableOpacity
          style={[styles.segmentButton, !testeParcelado && styles.segmentButtonActive]}
          onPress={() => setTesteParcelado(false)}
        >
          <Text style={[styles.segmentButtonText, !testeParcelado && styles.segmentButtonTextActive]}>
            {t('inicio.aVista')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segmentButton, testeParcelado && styles.segmentButtonActive]}
          onPress={() => setTesteParcelado(true)}
        >
          <Text style={[styles.segmentButtonText, testeParcelado && styles.segmentButtonTextActive]}>
            {t('inicio.parcelado')}
          </Text>
        </TouchableOpacity>
      </View>

      {testeParcelado && (
        <>
          <Text style={styles.inputLabel}>{t('inicio.emQuantasVezes')}</Text>
          <TextInput
            style={styles.input}
            value={testeNumeroParcelas}
            onChangeText={setTesteNumeroParcelas}
            keyboardType="number-pad"
            placeholder={t('inicio.placeholderParcelas')}
          />
        </>
      )}

      {!testeParcelado && impactoCompra && (
        <View
          style={[
            styles.purchaseResultBox,
            impactoCompra.novoStatus === 'verde' && styles.purchaseResultBoxVerde,
            impactoCompra.novoStatus === 'amarelo' && styles.purchaseResultBoxAmarelo,
            impactoCompra.novoStatus === 'vermelho' && styles.purchaseResultBoxVermelho,
          ]}
        >
          <Text style={styles.purchaseResultTitle}>
            {impactoCompra.novoStatus === 'verde' && t('inicio.impactoCompraVerde')}
            {impactoCompra.novoStatus === 'amarelo' && t('inicio.impactoCompraAmarelo')}
            {impactoCompra.novoStatus === 'vermelho' && t('inicio.impactoCompraVermelho')}
          </Text>
          <Text style={styles.purchaseResultText}>
            {impactoCompra.novoSaldoLivreHoje <= 0
              ? t('inicio.impactoCompraTextoVermelho', {
                  valor: formatarMoeda(Math.abs(impactoCompra.novoSaldoLivreHoje)),
                })
              : t('inicio.impactoCompraTextoOk', {
                  valor: formatarMoeda(impactoCompra.novoGastoDiarioSeguro),
                })}
          </Text>
        </View>
      )}

      {testeParcelado && previaTesteCompra && (
        <View style={styles.previaParcelamentoBox}>
          <Text style={styles.previaParcelamentoTitulo}>{t('inicio.previaDoImpacto')}</Text>
          {previaTesteCompra.resultadosPorMes.map((r, indice) => {
            const [ano, mesNumero] = r.chaveMes.split('-');
            const nomeMes = t(`comum.meses.${parseInt(mesNumero, 10) - 1}`);
            return (
              <Text key={indice} style={styles.previaParcelamentoLinha}>
                {nomeMes}/{ano}: {formatarMoeda(r.valorParcela)}
                {r.status === 'vermelho' && ` 🔴 ${t('inicio.vaiApertarBastante')}`}
                {r.status === 'amarelo' && ` 🟡 ${t('inicio.vaiFicarApertado')}`}
                {r.status === 'verde' && ` 🟢 ${t('inicio.tranquilo')}`}
              </Text>
            );
          })}
          {previaTesteCompra.rendaFixaMensal <= 0 && (
            <Text style={styles.helperText}>{t('inicio.cadastreRendaFixa')}</Text>
          )}
        </View>
      )}

      {/* "Sequência sem estourar" — conta os dias seguidos com o semáforo
          verde ou amarelo (nunca vermelho), tipo um streak de Duolingo */}
      <View style={styles.streakCard}>
        <Ionicons name="flame" size={22} color={cores.laranjaForte} />
        <View style={{ marginLeft: 10 }}>
          <Text style={styles.streakTexto}>
            {streakData.streakAtual > 0
              ? t('inicio.streakTexto', {
                  dias: streakData.streakAtual,
                  diaOuDias:
                    streakData.streakAtual === 1 ? t('inicio.diaSeguido') : t('inicio.diasSeguidos'),
                })
              : t('inicio.comeceSuaSequencia')}
          </Text>
          {streakData.melhorStreak > 0 && (
            <Text style={styles.streakRecorde}>
              {t('inicio.recorde', {
                dias: streakData.melhorStreak,
                diaOuDias: streakData.melhorStreak === 1 ? t('inicio.dia') : t('inicio.dias'),
              })}
            </Text>
          )}
        </View>
      </View>

      <TouchableOpacity style={styles.addButton} onPress={() => setModalVisivel(true)}>
        <Ionicons name="add-circle" size={20} color={cores.primario} />
        <Text style={styles.addButtonText}>{t('inicio.novaTransacao')}</Text>
      </TouchableOpacity>

      {/* Avisos de contas fixas que já venceram e esperam confirmação */}
      {contasFixasPendentes.length > 0 && (
        <View style={{ marginBottom: 8 }}>
          <Text style={styles.sectionTitle}>{t('inicio.contasFixasPendentes')}</Text>
          {contasFixasPendentes.map((c) => (
            <View key={c.id} style={styles.pendingCard}>
              <Ionicons name="alarm" size={20} color={cores.ambarTexto} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text style={styles.pendingTitle}>{c.titulo}</Text>
                <Text style={styles.pendingSubtitle}>
                  {c.tipo === 'entrada' ? t('inicio.entrada') : t('inicio.saida')}{' '}
                  {t('inicio.deValorTodoDia', { valor: formatarMoeda(c.valor), dia: c.diaDoMes })}
                </Text>
              </View>
              <TouchableOpacity style={styles.pendingButton} onPress={() => confirmarContaFixa(c)}>
                <Text style={styles.pendingButtonText}>{t('inicio.confirmar')}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Contas fixas cadastradas (salário, aluguel...) */}
      <Text style={styles.sectionTitle}>{t('inicio.contasFixas')}</Text>
      {contasFixas.length === 0 ? (
        <Text style={styles.helperText}>{t('inicio.contasFixasVazio')}</Text>
      ) : (
        contasFixas.map((c) => {
          const confirmadaEsseMes = c.ultimoMesConfirmado === mesAtualChave;
          return (
            <TouchableOpacity
              key={c.id}
              style={styles.fixedBillCard}
              onPress={() => abrirEdicaoContaFixa(c)}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.fixedBillTitle}>{c.titulo}</Text>
                <Text style={styles.fixedBillSubtitle}>
                  {t('inicio.tipoTodoDiaValor', {
                    tipo: c.tipo === 'entrada' ? t('inicio.entrada') : t('inicio.saida'),
                    dia: c.diaDoMes,
                    valor: formatarMoeda(c.valor),
                  })}
                </Text>
              </View>

              {/* Botão grande: um toque já confirma ou desfaz o recebimento/pagamento */}
              <TouchableOpacity
                onPress={() => alternarConfirmacaoContaFixa(c)}
                style={[
                  styles.confirmToggleButton,
                  confirmadaEsseMes ? styles.confirmToggleButtonOk : styles.confirmToggleButtonPendente,
                ]}
              >
                <Ionicons
                  name={confirmadaEsseMes ? 'checkmark-circle' : 'time-outline'}
                  size={16}
                  color={confirmadaEsseMes ? cores.verdeTextoForte : cores.branco}
                />
                <Text
                  style={[
                    styles.confirmToggleButtonText,
                    confirmadaEsseMes && styles.confirmToggleButtonTextOk,
                  ]}
                >
                  {confirmadaEsseMes
                    ? c.tipo === 'entrada'
                      ? t('inicio.recebido')
                      : t('inicio.pago')
                    : t('inicio.confirmar')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => removerContaFixa(c.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginLeft: 12 }}
              >
                <Ionicons name="trash-outline" size={18} color={cores.textoMuted} />
              </TouchableOpacity>
            </TouchableOpacity>
          );
        })
      )}
      <TouchableOpacity
        style={styles.addButton}
        onPress={() => {
          limparFormularioContaFixa();
          setModalContaFixaVisivel(true);
        }}
      >
        <Ionicons name="add-circle" size={20} color={cores.primario} />
        <Text style={styles.addButtonText}>{t('inicio.adicionarContaFixa')}</Text>
      </TouchableOpacity>

      {/* Parcelas das dívidas cadastradas na aba Dívidas — confirma o
          pagamento do mês direto por aqui, igual às contas fixas. Editar
          os dados da dívida (saldo, juros...) continua lá na aba Dívidas. */}
      <Text style={styles.sectionTitle}>{t('inicio.parcelasDeDividas')}</Text>
      {dividasAtivas.length === 0 ? (
        <Text style={styles.helperText}>{t('inicio.parcelasDeDividasVazio')}</Text>
      ) : (
        dividasAtivas.map((d) => {
          const confirmadaEsseMes = d.ultimoMesConfirmado === mesAtualChave;
          const parcelasPagas = d.parcelasPagas || 0;
          return (
            <View key={d.id} style={styles.fixedBillCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fixedBillTitle}>{d.nome}</Text>
                <Text style={styles.fixedBillSubtitle}>
                  {t('inicio.parcelaDeValor', { valor: formatarMoeda(d.parcelaMinima) })}
                  {d.numeroParcelas > 0
                    ? ` · ${t('inicio.xDeYPagas', { pagas: parcelasPagas, total: d.numeroParcelas })}`
                    : ` · ${t('inicio.xPagas', { pagas: parcelasPagas })}`}
                </Text>
              </View>

              {/* Botão grande: um toque já confirma ou desfaz o pagamento da parcela */}
              <TouchableOpacity
                onPress={() => alternarConfirmacaoParcelaDivida(d)}
                style={[
                  styles.confirmToggleButton,
                  confirmadaEsseMes ? styles.confirmToggleButtonOk : styles.confirmToggleButtonPendente,
                ]}
              >
                <Ionicons
                  name={confirmadaEsseMes ? 'checkmark-circle' : 'time-outline'}
                  size={16}
                  color={confirmadaEsseMes ? cores.verdeTextoForte : cores.branco}
                />
                <Text
                  style={[
                    styles.confirmToggleButtonText,
                    confirmadaEsseMes && styles.confirmToggleButtonTextOk,
                  ]}
                >
                  {confirmadaEsseMes ? t('inicio.pago') : t('inicio.confirmar')}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })
      )}

      {/* "Máquina do Tempo": projeta seu saldo lá na frente com base na
          média dos últimos meses fechados */}
      <Text style={styles.sectionTitle}>{t('inicio.maquinaDoTempo')}</Text>
      {!projecaoFinanceira ? (
        <Text style={styles.helperText}>{t('inicio.maquinaDoTempoVazio')}</Text>
      ) : (
        <View style={styles.timeMachineCard}>
          <Text style={styles.timeMachineTexto}>
            {t('inicio.mediaDosUltimosMeses', {
              meses: projecaoFinanceira.mesesConsiderados,
              mesOuMeses: projecaoFinanceira.mesesConsiderados === 1 ? t('inicio.mes') : t('inicio.meses'),
              sobraOuDeficit:
                projecaoFinanceira.mediaMensal >= 0 ? t('inicio.umaSobra') : t('inicio.umDeficit'),
              valor: formatarMoeda(Math.abs(projecaoFinanceira.mediaMensal)),
            })}
          </Text>
          <Text style={[styles.timeMachineTexto, { marginBottom: 10 }]}>
            {t('inicio.seContinuarNesseRitmo')}
          </Text>
          <View style={styles.row}>
            <View
              style={[
                styles.timeMachineProjecaoCard,
                saldoProjetado3Meses >= 0
                  ? styles.timeMachineProjecaoPositiva
                  : styles.timeMachineProjecaoNegativa,
              ]}
            >
              <Text style={styles.timeMachineProjecaoLabel}>{t('inicio.em3Meses')}</Text>
              <Text style={styles.timeMachineProjecaoValor}>{formatarMoeda(saldoProjetado3Meses)}</Text>
            </View>
            <View
              style={[
                styles.timeMachineProjecaoCard,
                saldoProjetado6Meses >= 0
                  ? styles.timeMachineProjecaoPositiva
                  : styles.timeMachineProjecaoNegativa,
              ]}
            >
              <Text style={styles.timeMachineProjecaoLabel}>{t('inicio.em6Meses')}</Text>
              <Text style={styles.timeMachineProjecaoValor}>{formatarMoeda(saldoProjetado6Meses)}</Text>
            </View>
          </View>
        </View>
      )}

      <Text style={styles.sectionTitle}>{t('inicio.historicoDeTransacoes')}</Text>
    </View>
  );

  if (carregandoTransacoes || carregandoContasFixas || carregandoDividas || carregandoStreak) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t('inicio.carregando')}</Text>
      </View>
    );
  }

  return (
    <>
      <SectionList
        sections={secoesTransacoes}
        keyExtractor={(item) => item.id}
        renderItem={renderTransacao}
        renderSectionHeader={({ section }) => (
          <Text style={styles.monthSectionHeader}>{section.title}</Text>
        )}
        ListHeaderComponent={cabecalhoElemento}
        ListEmptyComponent={listaVaziaElemento}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
      />

      {/* Modal pra adicionar uma nova transação */}
      <Modal visible={modalVisivel} animationType="slide" transparent onRequestClose={() => setModalVisivel(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{t('inicio.novaTransacao')}</Text>

            <Text style={styles.inputLabel}>{t('inicio.tipoLabelCampo')}</Text>
            <View style={styles.segmentedControl}>
              <TouchableOpacity
                style={[styles.segmentButton, novoTipo === 'entrada' && styles.segmentButtonActive]}
                onPress={() => setNovoTipo('entrada')}
              >
                <Text style={[styles.segmentButtonText, novoTipo === 'entrada' && styles.segmentButtonTextActive]}>
                  {t('inicio.entrada')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentButton, novoTipo === 'saida' && styles.segmentButtonActive]}
                onPress={() => setNovoTipo('saida')}
              >
                <Text style={[styles.segmentButtonText, novoTipo === 'saida' && styles.segmentButtonTextActive]}>
                  {t('inicio.saida')}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>{t('inicio.descricao')}</Text>
            <TextInput
              style={styles.input}
              value={novoTitulo}
              onChangeText={setNovoTitulo}
              placeholder={
                novoTipo === 'entrada'
                  ? t('inicio.placeholderDescricaoEntrada')
                  : t('inicio.placeholderDescricaoSaida')
              }
            />

            <Text style={styles.inputLabel}>{t('inicio.valorReais')}</Text>
            <TextInput
              style={styles.input}
              value={novoValor}
              onChangeText={setNovoValor}
              keyboardType="decimal-pad"
              placeholder={t('inicio.placeholderValorTransacao')}
            />

            {/* "Compra fantasma": só faz sentido pra saída. Lança todas as
                parcelas futuras de uma vez, pra você ver o impacto delas
                no histórico desde já (elas só entram no saldo quando a
                data de cada uma chegar). */}
            {novoTipo === 'saida' && (
              <>
                <Text style={styles.inputLabel}>{t('inicio.foiParceladoNoCartao')}</Text>
                <View style={styles.segmentedControl}>
                  <TouchableOpacity
                    style={[styles.segmentButton, !compraParcelada && styles.segmentButtonActive]}
                    onPress={() => setCompraParcelada(false)}
                  >
                    <Text style={[styles.segmentButtonText, !compraParcelada && styles.segmentButtonTextActive]}>
                      {t('comum.nao')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.segmentButton, compraParcelada && styles.segmentButtonActive]}
                    onPress={() => setCompraParcelada(true)}
                  >
                    <Text style={[styles.segmentButtonText, compraParcelada && styles.segmentButtonTextActive]}>
                      {t('comum.sim')}
                    </Text>
                  </TouchableOpacity>
                </View>

                {compraParcelada && (
                  <>
                    <Text style={styles.inputLabel}>{t('inicio.emQuantasVezes')}</Text>
                    <TextInput
                      style={styles.input}
                      value={numeroParcelasCompra}
                      onChangeText={setNumeroParcelasCompra}
                      keyboardType="number-pad"
                      placeholder={t('inicio.placeholderParcelas')}
                    />
                    <Text style={styles.helperText}>{t('inicio.helperParcelasFuturas')}</Text>

                    {/* Prévia: mostra ANTES de salvar em quais meses essa
                        parcela vai apertar, comparando com sua renda fixa
                        cadastrada */}
                    {previaParcelamento && (
                      <View style={styles.previaParcelamentoBox}>
                        <Text style={styles.previaParcelamentoTitulo}>{t('inicio.previaDoImpacto')}</Text>
                        {previaParcelamento.resultadosPorMes.map((r, indice) => {
                          const [ano, mesNumero] = r.chaveMes.split('-');
                          const nomeMes = t(`comum.meses.${parseInt(mesNumero, 10) - 1}`);
                          return (
                            <Text key={indice} style={styles.previaParcelamentoLinha}>
                              {nomeMes}/{ano}: {formatarMoeda(r.valorParcela)}
                              {r.status === 'vermelho' && ` 🔴 ${t('inicio.vaiApertarBastante')}`}
                              {r.status === 'amarelo' && ` 🟡 ${t('inicio.vaiFicarApertado')}`}
                              {r.status === 'verde' && ` 🟢 ${t('inicio.tranquilo')}`}
                            </Text>
                          );
                        })}
                        {previaParcelamento.rendaFixaMensal <= 0 && (
                          <Text style={styles.helperText}>{t('inicio.cadastreRendaFixa')}</Text>
                        )}
                      </View>
                    )}
                  </>
                )}
              </>
            )}

            <Text style={styles.inputLabel}>{t('inicio.data')}</Text>
            <TouchableOpacity style={styles.input} onPress={() => setMostrarSeletorData(true)}>
              <Text style={{ fontSize: 14, color: cores.texto }}>{dataParaBR(dataSelecionada)}</Text>
            </TouchableOpacity>
            {mostrarSeletorData && <SeletorDeData value={dataSelecionada} onChange={aoMudarData} />}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => {
                  limparFormulario();
                  setModalVisivel(false);
                }}
              >
                <Text style={styles.modalCancelButtonText}>{t('comum.cancelar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={salvarNovaTransacao}>
                <Text style={styles.modalConfirmButtonText}>{t('comum.salvar')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal pra adicionar uma nova conta fixa */}
      <Modal
        visible={modalContaFixaVisivel}
        animationType="slide"
        transparent
        onRequestClose={() => setModalContaFixaVisivel(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {contaFixaEditandoId ? t('inicio.editarContaFixa') : t('inicio.novaContaFixa')}
            </Text>

            <Text style={styles.inputLabel}>{t('inicio.tipoLabelCampo')}</Text>
            <View style={styles.segmentedControl}>
              <TouchableOpacity
                style={[styles.segmentButton, novoTipoFixa === 'entrada' && styles.segmentButtonActive]}
                onPress={() => setNovoTipoFixa('entrada')}
              >
                <Text style={[styles.segmentButtonText, novoTipoFixa === 'entrada' && styles.segmentButtonTextActive]}>
                  {t('inicio.entrada')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentButton, novoTipoFixa === 'saida' && styles.segmentButtonActive]}
                onPress={() => setNovoTipoFixa('saida')}
              >
                <Text style={[styles.segmentButtonText, novoTipoFixa === 'saida' && styles.segmentButtonTextActive]}>
                  {t('inicio.saida')}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>{t('comum.nome')}</Text>
            <TextInput
              style={styles.input}
              value={novoTituloFixa}
              onChangeText={setNovoTituloFixa}
              placeholder={novoTipoFixa === 'entrada' ? t('inicio.placeholderNomeFixaEntrada') : t('inicio.placeholderNomeFixaSaida')}
            />

            <Text style={styles.inputLabel}>{t('inicio.valorReais')}</Text>
            <TextInput
              style={styles.input}
              value={novoValorFixa}
              onChangeText={setNovoValorFixa}
              keyboardType="decimal-pad"
              placeholder={t('inicio.placeholderValorFixa')}
            />

            <Text style={styles.inputLabel}>{t('inicio.todoDiaDe1a28')}</Text>
            <TextInput
              style={styles.input}
              value={novoDiaFixa}
              onChangeText={setNovoDiaFixa}
              keyboardType="number-pad"
              placeholder={t('inicio.placeholderDiaFixa')}
            />

            {/* O status só faz sentido quando já existe uma conta fixa
                (numa nova, ainda não houve nenhum mês pra confirmar) */}
            {contaFixaEditandoId && (
              <>
                <Text style={styles.inputLabel}>{t('inicio.statusDesseMes')}</Text>
                <View style={styles.segmentedControl}>
                  <TouchableOpacity
                    style={[styles.segmentButton, !statusRecebidoEditando && styles.segmentButtonActive]}
                    onPress={() => setStatusRecebidoEditando(false)}
                  >
                    <Text
                      style={[styles.segmentButtonText, !statusRecebidoEditando && styles.segmentButtonTextActive]}
                    >
                      {t('inicio.pendente')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.segmentButton, statusRecebidoEditando && styles.segmentButtonActive]}
                    onPress={() => setStatusRecebidoEditando(true)}
                  >
                    <Text
                      style={[styles.segmentButtonText, statusRecebidoEditando && styles.segmentButtonTextActive]}
                    >
                      {novoTipoFixa === 'entrada' ? t('inicio.recebido') : t('inicio.pago')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => {
                  limparFormularioContaFixa();
                  setModalContaFixaVisivel(false);
                }}
              >
                <Text style={styles.modalCancelButtonText}>{t('comum.cancelar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={salvarContaFixa}>
                <Text style={styles.modalConfirmButtonText}>{t('comum.salvar')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ============================================================
// ABA 2: DÍVIDAS — o módulo novo
// ============================================================

// A tela de Dívidas começa vazia — cada pessoa cadastra as suas de
// verdade, sem exemplos fictícios pra confundir.
const DIVIDAS_INICIAIS = [];

// Ordena as dívidas de acordo com a estratégia escolhida.
// - Avalanche: maior taxa de juros primeiro (economiza mais dinheiro)
// - Bola de Neve: menor saldo devedor primeiro (motivação mais rápida)
function ordenarDividas(dividas, estrategia) {
  const copia = [...dividas];
  if (estrategia === 'avalanche') {
    copia.sort((a, b) => b.taxaJurosMensal - a.taxaJurosMensal);
  } else {
    copia.sort((a, b) => a.saldoDevedor - b.saldoDevedor);
  }
  return copia;
}

// Simula, mês a mês, o processo de quitar todas as dívidas seguindo
// a ordem de prioridade recebida, aplicando o valor extra sempre na
// primeira dívida da lista que ainda não foi quitada.
function simularQuitacao(dividasOrdenadas, extraMensal) {
  let dividas = dividasOrdenadas.map((d) => ({ ...d }));
  let totalJurosPago = 0;
  let mes = 0;
  const LIMITE_MESES = 600; // trava de segurança (50 anos) pra não travar o app

  while (dividas.some((d) => d.saldoDevedor > 0.01) && mes < LIMITE_MESES) {
    mes++;
    const alvo = dividas.find((d) => d.saldoDevedor > 0.01);

    dividas = dividas.map((d) => {
      if (d.saldoDevedor <= 0.01) return d; // já quitada

      const juros = d.saldoDevedor * (d.taxaJurosMensal / 100);
      totalJurosPago += juros;
      let novoSaldo = d.saldoDevedor + juros;

      let pagamento = Math.min(d.parcelaMinima, novoSaldo);
      if (alvo && d.id === alvo.id) {
        // A dívida prioritária da vez recebe o extra, além da parcela mínima
        pagamento = Math.min(d.parcelaMinima + extraMensal, novoSaldo);
      }

      return { ...d, saldoDevedor: novoSaldo - pagamento };
    });
  }

  return {
    meses: mes,
    totalJurosPago,
    quitouTudo: dividas.every((d) => d.saldoDevedor <= 0.01),
  };
}

// Card visual de cada dívida na lista. Tocar em qualquer lugar do card
// (fora dos botões) abre a edição; o toque na lixeira continua removendo.
function CardDivida({ divida, posicao, destaque, onRemover, onEditar }) {
  const { estilos: styles, cores } = useTema();
  const { t } = useIdioma();
  const jurosMensal = divida.saldoDevedor * (divida.taxaJurosMensal / 100);
  const alertaJurosAltos = divida.parcelaMinima <= jurosMensal;
  const quitada = dividaEstaQuitada(divida);
  const parcelasPagas = divida.parcelasPagas || 0;
  const mesAtualChave = dataParaISO(new Date()).slice(0, 7);
  const parcelaConfirmadaEsseMes = divida.ultimoMesConfirmado === mesAtualChave;

  return (
    <TouchableOpacity
      style={[styles.debtCard, destaque && styles.debtCardDestaque, quitada && styles.debtCardQuitada]}
      onPress={() => onEditar(divida)}
      activeOpacity={0.7}
    >
      <View style={styles.debtCardTopRow}>
        <View style={styles.debtBadge}>
          {quitada ? (
            <Ionicons name="checkmark" size={14} color={cores.verde} />
          ) : (
            <Text style={styles.debtBadgeText}>{posicao}º</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.debtName}>{divida.nome}</Text>
          {destaque && !quitada && <Text style={styles.debtFocoLabel}>🎯 {t('dividas.focoAgora')}</Text>}
        </View>
        <TouchableOpacity onPress={() => onRemover(divida.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="trash-outline" size={20} color={cores.textoMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>{t('dividas.saldoDevedor')}</Text>
        <Text style={styles.debtInfoValue}>{formatarMoeda(divida.saldoDevedor)}</Text>
      </View>
      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>{t('dividas.juros')}</Text>
        <Text style={styles.debtInfoValue}>
          {t('dividas.taxaAoMesLinha', {
            taxa: divida.taxaJurosMensal.toLocaleString('pt-BR'),
            valorJuros: formatarMoeda(jurosMensal),
          })}
        </Text>
      </View>
      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>
          {divida.numeroParcelas > 0 ? t('dividas.valorParcela') : t('dividas.parcelaMinima')}
        </Text>
        <Text style={styles.debtInfoValue}>{formatarMoeda(divida.parcelaMinima)}</Text>
      </View>
      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>{t('dividas.parcelasPagas')}</Text>
        <Text style={styles.debtInfoValue}>
          {divida.numeroParcelas > 0
            ? t('dividas.parcelasPagasFracao', { pagas: parcelasPagas, total: divida.numeroParcelas })
            : `${parcelasPagas}`}
        </Text>
      </View>

      {quitada ? (
        <Text style={styles.comparisonBadge}>{t('dividas.dividaQuitada')}</Text>
      ) : (
        <Text style={styles.debtStatusMesTexto}>
          {parcelaConfirmadaEsseMes ? t('dividas.parcelaPagaEsteMes') : t('dividas.parcelaPendenteEsteMes')}
        </Text>
      )}

      {!quitada && alertaJurosAltos && (
        <View style={styles.debtWarningBox}>
          <Ionicons name="warning" size={14} color={cores.ambarTexto} />
          <Text style={styles.debtWarningText}>{t('dividas.avisoJurosAltos')}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ============================================================
// ABA INVESTIMENTOS
// ============================================================

// Card de um investimento cadastrado. Tocar nele (fora da lixeira) abre
// a edição — mesmo padrão do CardDivida.
function CardInvestimento({ investimento, onRemover, onEditar }) {
  const { estilos: styles, cores } = useTema();
  const { t } = useIdioma();
  const rendimentoValor = arredondar2(investimento.valorAtual - investimento.valorInvestido);
  const rendimentoPercentual =
    investimento.valorInvestido > 0 ? arredondar2((rendimentoValor / investimento.valorInvestido) * 100) : 0;
  const positivo = rendimentoValor >= 0;
  const corTipo = corDoTipoInvestimento(investimento.tipo, cores);

  return (
    <TouchableOpacity
      style={styles.investCard}
      onPress={() => onEditar(investimento)}
      activeOpacity={0.7}
    >
      <View style={styles.investCardTopRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.investName}>{investimento.nome}</Text>
          <View style={[styles.investTipoBadge, { backgroundColor: corTipo + '22', borderColor: corTipo }]}>
            <Text style={[styles.investTipoBadgeText, { color: corTipo }]}>
              {traduzirTipoInvestimento(investimento.tipo, t)}
            </Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => onRemover(investimento.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="trash-outline" size={20} color={cores.textoMuted} />
        </TouchableOpacity>
      </View>

      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>{t('investimentos.valorInvestidoLabel')}</Text>
        <Text style={styles.debtInfoValue}>{formatarMoeda(investimento.valorInvestido)}</Text>
      </View>
      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>{t('investimentos.valorAtualLabel')}</Text>
        <Text style={styles.debtInfoValue}>{formatarMoeda(investimento.valorAtual)}</Text>
      </View>
      <View style={styles.debtInfoRow}>
        <Text style={styles.debtInfoLabel}>{t('investimentos.rendimentoLabel')}</Text>
        <Text style={[styles.debtInfoValue, { color: positivo ? cores.verdeTextoForte : cores.vermelhoTextoForte }]}>
          {positivo ? '+' : ''}
          {formatarMoeda(rendimentoValor)} ({positivo ? '+' : ''}
          {rendimentoPercentual.toLocaleString('pt-BR')}%)
        </Text>
      </View>
    </TouchableOpacity>
  );
}

// Card de uma meta de economia. Tocar nele (fora da lixeira) abre a edição.
function CardMeta({ meta, onRemover, onEditar }) {
  const { estilos: styles, cores } = useTema();
  const { t } = useIdioma();
  const resultado = calcularMeta(meta, new Date());

  return (
    <TouchableOpacity style={styles.metaCard} onPress={() => onEditar(meta)} activeOpacity={0.7}>
      <View style={styles.metaCardTopRow}>
        <Text style={styles.metaName}>{meta.nome}</Text>
        <TouchableOpacity onPress={() => onRemover(meta.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="trash-outline" size={20} color={cores.textoMuted} />
        </TouchableOpacity>
      </View>

      <Text style={styles.metaValorText}>
        {t('comum.xDeY', { x: formatarMoeda(meta.valorAtual), y: formatarMoeda(meta.valorAlvo) })}
      </Text>
      <View style={styles.metaProgressTrack}>
        <View
          style={[
            styles.metaProgressFill,
            { width: `${resultado.progresso}%` },
            resultado.atingida && styles.metaProgressFillCompleta,
          ]}
        />
      </View>
      <Text style={styles.metaProgressLabel}>
        {t('investimentos.metaProgressoLabel', { progresso: resultado.progresso.toLocaleString('pt-BR') })}
        {meta.dataAlvo
          ? t('investimentos.metaAteData', { data: dataParaBR(dataISOParaData(meta.dataAlvo)) })
          : ''}
      </Text>

      {resultado.atingida ? (
        <Text style={styles.metaAtingidaTexto}>{t('investimentos.metaAtingida')}</Text>
      ) : resultado.valorMensalNecessario !== null ? (
        <Text style={styles.metaSugestaoTexto}>
          {t(
            resultado.mesesRestantes === 1
              ? 'investimentos.metaSugestaoComDataSingular'
              : 'investimentos.metaSugestaoComDataPlural',
            {
              faltam: formatarMoeda(resultado.faltam),
              valorMensal: formatarMoeda(resultado.valorMensalNecessario),
              meses: resultado.mesesRestantes,
            }
          )}
        </Text>
      ) : (
        <Text style={styles.metaSugestaoTexto}>
          {t('investimentos.metaFaltam', { faltam: formatarMoeda(resultado.faltam) })}
        </Text>
      )}
    </TouchableOpacity>
  );
}

function TelaInvestimentos() {
  const { estilos: styles, cores } = useTema();
  const { t } = useIdioma();
  const { user } = useAuth();
  const userId = user.id;
  const [investimentos, setInvestimentos] = useState([]);
  const [carregandoInvestimentos, setCarregandoInvestimentos] = useState(true);
  const [modalVisivel, setModalVisivel] = useState(false);
  const [investimentoEditandoId, setInvestimentoEditandoId] = useState(null);

  // Campos do formulário (também usados na edição)
  const [novoNome, setNovoNome] = useState('');
  const [novoTipo, setNovoTipo] = useState(TIPOS_INVESTIMENTO[1]);
  const [novoValorInvestido, setNovoValorInvestido] = useState('');
  const [novoValorAtual, setNovoValorAtual] = useState('');

  // Dados de outras abas, só pra LER (não são salvos daqui): as contas
  // fixas dão a meta de reserva de emergência, e as dívidas alimentam o
  // comparador "investir ou quitar?" logo abaixo.
  const [contasFixas, setContasFixas] = useState([]);
  const [dividas, setDividas] = useState([]);
  const [carregandoDadosExternos, setCarregandoDadosExternos] = useState(true);

  const [dividaComparadaId, setDividaComparadaId] = useState(null);
  const [taxaInvestimentoTexto, setTaxaInvestimentoTexto] = useState('10');

  // Simulador de futuro/aposentadoria
  const [aporteMensalTexto, setAporteMensalTexto] = useState('300');
  const [taxaSimulacaoTexto, setTaxaSimulacaoTexto] = useState('10');

  // Metas de economia (ex: "juntar R$3000 pra uma viagem")
  const [metas, setMetas] = useState([]);
  const [carregandoMetas, setCarregandoMetas] = useState(true);
  const [modalMetaVisivel, setModalMetaVisivel] = useState(false);
  const [metaEditandoId, setMetaEditandoId] = useState(null);
  const [novoNomeMeta, setNovoNomeMeta] = useState('');
  const [novoValorAlvoMeta, setNovoValorAlvoMeta] = useState('');
  const [novoValorAtualMeta, setNovoValorAtualMeta] = useState('');
  const [metaTemData, setMetaTemData] = useState(false);
  const [metaDataSelecionada, setMetaDataSelecionada] = useState(new Date());
  const [mostrarSeletorDataMeta, setMostrarSeletorDataMeta] = useState(false);

  useEffect(() => {
    async function carregarInvestimentosSalvos() {
      try {
        const investimentosCarregados = await buscarLinhasDoUsuario(
          TABELA_INVESTIMENTOS,
          userId,
          linhaParaInvestimento
        );
        setInvestimentos(investimentosCarregados);
      } catch (erro) {
        console.log('Não foi possível carregar os investimentos salvos:', erro);
      } finally {
        setCarregandoInvestimentos(false);
      }
    }
    carregarInvestimentosSalvos();
  }, [userId]);

  useEffect(() => {
    if (carregandoInvestimentos) return;
    sincronizarLinhasDoUsuario(TABELA_INVESTIMENTOS, userId, investimentos, investimentoParaLinha).catch((erro) => {
      console.log('Não foi possível salvar os investimentos:', erro);
    });
  }, [investimentos, carregandoInvestimentos, userId]);

  useEffect(() => {
    async function carregarMetasSalvas() {
      try {
        const metasCarregadas = await buscarLinhasDoUsuario(TABELA_METAS, userId, linhaParaMeta);
        setMetas(metasCarregadas);
      } catch (erro) {
        console.log('Não foi possível carregar as metas salvas:', erro);
      } finally {
        setCarregandoMetas(false);
      }
    }
    carregarMetasSalvas();
  }, [userId]);

  useEffect(() => {
    if (carregandoMetas) return;
    sincronizarLinhasDoUsuario(TABELA_METAS, userId, metas, metaParaLinha).catch((erro) => {
      console.log('Não foi possível salvar as metas:', erro);
    });
  }, [metas, carregandoMetas, userId]);

  // Carrega contas fixas e dívidas uma vez só, quando essa aba abre (só
  // leitura, essa tela não grava nessas duas tabelas). Como as abas são
  // desmontadas ao trocar, voltar aqui sempre traz os dados mais recentes
  // das outras telas.
  useEffect(() => {
    async function carregarDadosExternos() {
      try {
        const [contasCarregadas, dividasCarregadas] = await Promise.all([
          buscarLinhasDoUsuario(TABELA_CONTAS_FIXAS, userId, linhaParaContaFixa),
          buscarLinhasDoUsuario(TABELA_DIVIDAS, userId, linhaParaDivida),
        ]);
        setContasFixas(contasCarregadas);
        setDividas(dividasCarregadas);
      } catch (erro) {
        console.log('Não foi possível carregar dados de outras abas:', erro);
      } finally {
        setCarregandoDadosExternos(false);
      }
    }
    carregarDadosExternos();
  }, [userId]);

  const resumo = calcularResumoInvestimentos(investimentos);
  const reserva = calcularReservaEmergencia(investimentos, contasFixas);
  const rendimentoPositivo = resumo.rendimentoValor >= 0;

  const dividasComparador = dividas.filter((d) => !dividaEstaQuitada(d) && d.taxaJurosMensal > 0);
  const dividaSelecionada =
    dividasComparador.find((d) => d.id === dividaComparadaId) || dividasComparador[0] || null;
  const taxaInvestimentoAnual = paraNumero(taxaInvestimentoTexto);
  const comparador = dividaSelecionada
    ? calcularComparadorInvestDivida(dividaSelecionada.taxaJurosMensal, taxaInvestimentoAnual)
    : null;

  // Simulador de futuro: parte do que você já tem investido hoje e projeta
  // pra frente, considerando um aporte mensal fixo e uma taxa esperada.
  const aporteMensalSimulacao = paraNumero(aporteMensalTexto);
  const taxaSimulacaoAnual = paraNumero(taxaSimulacaoTexto);
  const projecoesFuturo = HORIZONTES_SIMULACAO_FUTURO.map((anos) => ({
    anos,
    valor: calcularSimulacaoFuturo(resumo.totalAtual, aporteMensalSimulacao, taxaSimulacaoAnual, anos),
  }));

  function limparFormulario() {
    setNovoNome('');
    setNovoTipo(TIPOS_INVESTIMENTO[1]);
    setNovoValorInvestido('');
    setNovoValorAtual('');
    setInvestimentoEditandoId(null);
  }

  function abrirEdicaoInvestimento(investimento) {
    setInvestimentoEditandoId(investimento.id);
    setNovoNome(investimento.nome);
    setNovoTipo(investimento.tipo);
    setNovoValorInvestido(String(investimento.valorInvestido));
    setNovoValorAtual(String(investimento.valorAtual));
    setModalVisivel(true);
  }

  function confirmarRemocao(id) {
    avisar(t('investimentos.confirmarRemocaoTitulo'), t('investimentos.confirmarRemocaoMensagem'), [
      { text: t('comum.cancelar'), style: 'cancel' },
      {
        text: t('comum.remover'),
        style: 'destructive',
        onPress: () => setInvestimentos((atual) => atual.filter((i) => i.id !== id)),
      },
    ]);
  }

  function salvarInvestimento() {
    const valorInvestido = paraNumero(novoValorInvestido);
    const valorAtual = novoValorAtual.trim() ? paraNumero(novoValorAtual) : valorInvestido;

    if (!novoNome.trim()) {
      avisar(t('comum.ops'), t('investimentos.erroNome'));
      return;
    }
    if (valorInvestido <= 0) {
      avisar(t('comum.ops'), t('investimentos.erroValorInvestido'));
      return;
    }
    if (valorAtual < 0) {
      avisar(t('comum.ops'), t('investimentos.erroValorAtual'));
      return;
    }

    if (investimentoEditandoId) {
      setInvestimentos((atual) =>
        atual.map((i) =>
          i.id === investimentoEditandoId
            ? { ...i, nome: novoNome.trim(), tipo: novoTipo, valorInvestido, valorAtual }
            : i
        )
      );
    } else {
      setInvestimentos((atual) => [
        ...atual,
        {
          id: Date.now().toString(),
          nome: novoNome.trim(),
          tipo: novoTipo,
          valorInvestido,
          valorAtual,
        },
      ]);
    }

    limparFormulario();
    setModalVisivel(false);
  }

  function limparFormularioMeta() {
    setNovoNomeMeta('');
    setNovoValorAlvoMeta('');
    setNovoValorAtualMeta('');
    setMetaTemData(false);
    setMetaDataSelecionada(new Date());
    setMetaEditandoId(null);
  }

  function abrirEdicaoMeta(meta) {
    setMetaEditandoId(meta.id);
    setNovoNomeMeta(meta.nome);
    setNovoValorAlvoMeta(String(meta.valorAlvo));
    setNovoValorAtualMeta(String(meta.valorAtual));
    setMetaTemData(!!meta.dataAlvo);
    setMetaDataSelecionada(meta.dataAlvo ? dataISOParaData(meta.dataAlvo) : new Date());
    setModalMetaVisivel(true);
  }

  function confirmarRemocaoMeta(id) {
    avisar(t('investimentos.confirmarRemocaoMetaTitulo'), t('investimentos.confirmarRemocaoMetaMensagem'), [
      { text: t('comum.cancelar'), style: 'cancel' },
      {
        text: t('comum.remover'),
        style: 'destructive',
        onPress: () => setMetas((atual) => atual.filter((m) => m.id !== id)),
      },
    ]);
  }

  function aoMudarDataMeta(evento, dataEscolhida) {
    setMostrarSeletorDataMeta(false); // no Android o calendário some sozinho
    if (dataEscolhida) {
      setMetaDataSelecionada(dataEscolhida);
    }
  }

  function salvarMeta() {
    const valorAlvo = paraNumero(novoValorAlvoMeta);
    const valorAtual = novoValorAtualMeta.trim() ? paraNumero(novoValorAtualMeta) : 0;

    if (!novoNomeMeta.trim()) {
      avisar(t('comum.ops'), t('investimentos.erroNomeMeta'));
      return;
    }
    if (valorAlvo <= 0) {
      avisar(t('comum.ops'), t('investimentos.erroValorAlvoMeta'));
      return;
    }
    if (valorAtual < 0) {
      avisar(t('comum.ops'), t('investimentos.erroValorAtualMeta'));
      return;
    }

    const dataAlvo = metaTemData ? dataParaISO(metaDataSelecionada) : null;

    if (metaEditandoId) {
      setMetas((atual) =>
        atual.map((m) =>
          m.id === metaEditandoId ? { ...m, nome: novoNomeMeta.trim(), valorAlvo, valorAtual, dataAlvo } : m
        )
      );
    } else {
      setMetas((atual) => [
        ...atual,
        {
          id: Date.now().toString(),
          nome: novoNomeMeta.trim(),
          valorAlvo,
          valorAtual,
          dataAlvo,
        },
      ]);
    }

    limparFormularioMeta();
    setModalMetaVisivel(false);
  }

  if (carregandoInvestimentos || carregandoDadosExternos || carregandoMetas) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t('investimentos.carregando')}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.headerTitle}>{t('investimentos.headerTitulo')}</Text>
        <Text style={styles.headerSubtitle}>
          {t('investimentos.totalInvestido', { valor: formatarMoeda(resumo.totalInvestido) })}
        </Text>

        <View style={styles.row}>
          <View style={[styles.smallCard, styles.incomeCard]}>
            <View style={styles.smallCardHeader}>
              <Ionicons name="trending-up" size={18} color={cores.verde} />
              <Text style={styles.smallCardLabel}>{t('investimentos.valorAtualLabel')}</Text>
            </View>
            <Text style={[styles.smallCardValue, { color: cores.verdeTextoForte }]}>
              {formatarMoeda(resumo.totalAtual)}
            </Text>
          </View>
          <View style={[styles.smallCard, rendimentoPositivo ? styles.incomeCard : styles.expenseCard]}>
            <View style={styles.smallCardHeader}>
              <Ionicons
                name={rendimentoPositivo ? 'arrow-up-circle' : 'arrow-down-circle'}
                size={18}
                color={rendimentoPositivo ? cores.verde : cores.vermelho}
              />
              <Text style={styles.smallCardLabel}>{t('investimentos.rendimentoLabel')}</Text>
            </View>
            <Text
              style={[
                styles.smallCardValue,
                { color: rendimentoPositivo ? cores.verdeTextoForte : cores.vermelhoTextoForte },
              ]}
            >
              {rendimentoPositivo ? '+' : ''}
              {formatarMoeda(resumo.rendimentoValor)}
            </Text>
            <Text style={styles.smallCardPeriodo}>
              {t('investimentos.rendimentoPercentualNoTotal', {
                sinal: rendimentoPositivo ? '+' : '',
                percentual: resumo.rendimentoPercentual.toLocaleString('pt-BR'),
              })}
            </Text>
          </View>
        </View>

        {resumo.alocacao.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('investimentos.comoEstaDividido')}</Text>
            <View style={styles.allocationBarContainer}>
              {resumo.alocacao.map((a) => (
                <View
                  key={a.tipo}
                  style={{
                    flex: a.percentual > 0 ? a.percentual : 0.001,
                    backgroundColor: corDoTipoInvestimento(a.tipo, cores),
                  }}
                />
              ))}
            </View>
            {resumo.alocacao.map((a) => (
              <View key={a.tipo} style={styles.allocationLegendRow}>
                <View style={[styles.allocationLegendDot, { backgroundColor: corDoTipoInvestimento(a.tipo, cores) }]} />
                <Text style={styles.allocationLegendText}>{traduzirTipoInvestimento(a.tipo, t)}</Text>
                <Text style={styles.allocationLegendPercent}>
                  {t('investimentos.alocacaoLinha', {
                    percentual: a.percentual.toLocaleString('pt-BR'),
                    valor: formatarMoeda(a.valorAtual),
                  })}
                </Text>
              </View>
            ))}
          </>
        )}

        {/* Reserva de emergência — usa as contas fixas de saída cadastradas
            na aba Início pra calcular quanto vale 6 meses de despesas. */}
        <Text style={styles.sectionTitle}>{t('investimentos.reservaTitulo')}</Text>
        <Text style={styles.helperText}>{t('investimentos.reservaHelper')}</Text>
        <View style={styles.reserveCard}>
          {reserva.metaReserva > 0 ? (
            <>
              <Text style={styles.reserveValueText}>
                {t('comum.xDeY', { x: formatarMoeda(reserva.valorReserva), y: formatarMoeda(reserva.metaReserva) })}
              </Text>
              <View style={styles.reserveProgressTrack}>
                <View style={[styles.reserveProgressFill, { width: `${reserva.progresso}%` }]} />
              </View>
              <Text style={styles.reserveProgressLabel}>
                {t('investimentos.reservaProgressoLabel', {
                  progresso: reserva.progresso.toLocaleString('pt-BR'),
                  valor: formatarMoeda(reserva.gastosFixosMensais),
                })}
              </Text>
            </>
          ) : (
            <Text style={styles.helperText}>{t('investimentos.reservaSemContasFixas')}</Text>
          )}
        </View>

        {/* Metas de economia — diferente da reserva de emergência (que é
            fixa), são metas livres que você cria, tipo "juntar R$3000 pra
            uma viagem até dezembro". */}
        <Text style={styles.sectionTitle}>{t('investimentos.metasTitulo')}</Text>
        <Text style={styles.helperText}>{t('investimentos.metasHelper')}</Text>

        {metas.map((m) => (
          <CardMeta key={m.id} meta={m} onRemover={confirmarRemocaoMeta} onEditar={abrirEdicaoMeta} />
        ))}

        {metas.length === 0 && (
          <View style={styles.emptyContainer}>
            <Ionicons name="flag-outline" size={48} color={cores.textoMuted} />
            <Text style={styles.emptyTitle}>{t('investimentos.metasVazioTitulo')}</Text>
            <Text style={styles.emptySubtitle}>{t('investimentos.metasVazioSubtitulo')}</Text>
          </View>
        )}

        <TouchableOpacity style={styles.addButton} onPress={() => setModalMetaVisivel(true)}>
          <Ionicons name="add-circle" size={20} color={cores.primario} />
          <Text style={styles.addButtonText}>{t('investimentos.adicionarMeta')}</Text>
        </TouchableOpacity>

        {/* O comparador — o motivo desse app te dar um motivo de verdade
            pra ter uma aba de investimentos junto com as dívidas. */}
        {dividasComparador.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('investimentos.comparadorTitulo')}</Text>
            <Text style={styles.helperText}>{t('investimentos.comparadorHelper')}</Text>

            {dividasComparador.length > 1 && (
              <View style={styles.chipRow}>
                {dividasComparador.map((d) => (
                  <TouchableOpacity
                    key={d.id}
                    style={[styles.chip, dividaSelecionada?.id === d.id && styles.chipActive]}
                    onPress={() => setDividaComparadaId(d.id)}
                  >
                    <Text style={[styles.chipText, dividaSelecionada?.id === d.id && styles.chipTextActive]}>
                      {d.nome}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            <Text style={styles.inputLabel}>{t('investimentos.retornoEsperadoLabel')}</Text>
            <Text style={styles.helperText}>{t('investimentos.retornoEsperadoHelper')}</Text>
            <TextInput
              style={styles.input}
              value={taxaInvestimentoTexto}
              onChangeText={setTaxaInvestimentoTexto}
              keyboardType="decimal-pad"
              placeholder={t('investimentos.placeholderTaxa')}
            />

            {comparador && dividaSelecionada && (
              <View
                style={[
                  styles.comparadorResultBox,
                  comparador.vantagemQuitar ? styles.comparadorResultBoxQuitar : styles.comparadorResultBoxInvestir,
                ]}
              >
                <Text
                  style={[
                    styles.comparadorResultTitle,
                    { color: comparador.vantagemQuitar ? cores.ambarTextoForte : cores.verdeTextoForte },
                  ]}
                >
                  {t('investimentos.comparadorResultTitulo', {
                    nome: dividaSelecionada.nome,
                    taxa: comparador.taxaAnualDivida.toLocaleString('pt-BR'),
                  })}
                </Text>
                <Text
                  style={[
                    styles.comparadorResultText,
                    { color: comparador.vantagemQuitar ? cores.ambarTexto : cores.verdeTextoForte },
                  ]}
                >
                  {comparador.vantagemQuitar
                    ? t('investimentos.comparadorResultQuitar', {
                        diferenca: Math.abs(comparador.diferenca).toLocaleString('pt-BR'),
                      })
                    : t('investimentos.comparadorResultInvestir')}
                </Text>
              </View>
            )}
          </>
        )}

        {/* Simulador de futuro: parte do total que você já tem investido e
            projeta pra frente com aportes mensais e uma taxa esperada. */}
        <Text style={styles.sectionTitle}>{t('investimentos.simuladorTitulo')}</Text>
        <Text style={styles.helperText}>
          {t('investimentos.simuladorHelper', { valor: formatarMoeda(resumo.totalAtual) })}
        </Text>

        <Text style={styles.inputLabel}>{t('investimentos.aporteMensalLabel')}</Text>
        <TextInput
          style={styles.input}
          value={aporteMensalTexto}
          onChangeText={setAporteMensalTexto}
          keyboardType="decimal-pad"
          placeholder={t('investimentos.placeholderAporte')}
        />

        <Text style={styles.inputLabel}>{t('investimentos.retornoEsperadoLabel')}</Text>
        <TextInput
          style={styles.input}
          value={taxaSimulacaoTexto}
          onChangeText={setTaxaSimulacaoTexto}
          keyboardType="decimal-pad"
          placeholder={t('investimentos.placeholderTaxa')}
        />

        <View style={styles.row}>
          {projecoesFuturo.slice(0, 2).map((p) => (
            <View key={p.anos} style={styles.simuladorFuturoCard}>
              <Text style={styles.simuladorFuturoLabel}>{t('investimentos.emXAnos', { anos: p.anos })}</Text>
              <Text style={styles.simuladorFuturoValor}>{formatarMoeda(p.valor)}</Text>
            </View>
          ))}
        </View>
        <View style={styles.row}>
          {projecoesFuturo.slice(2, 4).map((p) => (
            <View key={p.anos} style={styles.simuladorFuturoCard}>
              <Text style={styles.simuladorFuturoLabel}>{t('investimentos.emXAnos', { anos: p.anos })}</Text>
              <Text style={styles.simuladorFuturoValor}>{formatarMoeda(p.valor)}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>{t('investimentos.meusInvestimentos')}</Text>
        {investimentos.map((i) => (
          <CardInvestimento
            key={i.id}
            investimento={i}
            onRemover={confirmarRemocao}
            onEditar={abrirEdicaoInvestimento}
          />
        ))}

        {investimentos.length === 0 && (
          <View style={styles.emptyContainer}>
            <Ionicons name="trending-up-outline" size={48} color={cores.textoMuted} />
            <Text style={styles.emptyTitle}>{t('investimentos.vazioTitulo')}</Text>
            <Text style={styles.emptySubtitle}>{t('investimentos.vazioSubtitulo')}</Text>
          </View>
        )}

        <TouchableOpacity style={styles.addButton} onPress={() => setModalVisivel(true)}>
          <Ionicons name="add-circle" size={20} color={cores.primario} />
          <Text style={styles.addButtonText}>{t('investimentos.adicionarInvestimento')}</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Modal pra adicionar ou editar um investimento */}
      <Modal visible={modalVisivel} animationType="slide" transparent onRequestClose={() => setModalVisivel(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {investimentoEditandoId ? t('investimentos.modalEditarTitulo') : t('investimentos.modalNovoTitulo')}
            </Text>

            <Text style={styles.inputLabel}>{t('comum.nome')}</Text>
            <TextInput
              style={styles.input}
              value={novoNome}
              onChangeText={setNovoNome}
              placeholder={t('investimentos.placeholderNome')}
            />

            <Text style={styles.inputLabel}>{t('investimentos.tipoLabelCampo')}</Text>
            <View style={styles.chipRow}>
              {TIPOS_INVESTIMENTO.map((tipo) => (
                <TouchableOpacity
                  key={tipo}
                  style={[styles.chip, novoTipo === tipo && styles.chipActive]}
                  onPress={() => setNovoTipo(tipo)}
                >
                  <Text style={[styles.chipText, novoTipo === tipo && styles.chipTextActive]}>
                    {traduzirTipoInvestimento(tipo, t)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>{t('investimentos.valorInvestidoLabelReais')}</Text>
            <Text style={styles.helperText}>{t('investimentos.helperValorInvestido')}</Text>
            <TextInput
              style={styles.input}
              value={novoValorInvestido}
              onChangeText={setNovoValorInvestido}
              keyboardType="decimal-pad"
              placeholder={t('investimentos.placeholderValorInvestido')}
            />

            <Text style={styles.inputLabel}>{t('investimentos.valorAtualLabelReais')}</Text>
            <Text style={styles.helperText}>{t('investimentos.helperValorAtual')}</Text>
            <TextInput
              style={styles.input}
              value={novoValorAtual}
              onChangeText={setNovoValorAtual}
              keyboardType="decimal-pad"
              placeholder={t('investimentos.placeholderValorAtual')}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => {
                  limparFormulario();
                  setModalVisivel(false);
                }}
              >
                <Text style={styles.modalCancelButtonText}>{t('comum.cancelar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={salvarInvestimento}>
                <Text style={styles.modalConfirmButtonText}>{t('comum.salvar')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Modal pra adicionar ou editar uma meta de economia */}
      <Modal
        visible={modalMetaVisivel}
        animationType="slide"
        transparent
        onRequestClose={() => setModalMetaVisivel(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {metaEditandoId ? t('investimentos.modalMetaEditarTitulo') : t('investimentos.modalMetaNovaTitulo')}
            </Text>

            <Text style={styles.inputLabel}>{t('comum.nome')}</Text>
            <TextInput
              style={styles.input}
              value={novoNomeMeta}
              onChangeText={setNovoNomeMeta}
              placeholder={t('investimentos.placeholderNomeMeta')}
            />

            <Text style={styles.inputLabel}>{t('investimentos.valorAlvoMetaLabel')}</Text>
            <TextInput
              style={styles.input}
              value={novoValorAlvoMeta}
              onChangeText={setNovoValorAlvoMeta}
              keyboardType="decimal-pad"
              placeholder={t('investimentos.placeholderValorAlvoMeta')}
            />

            <Text style={styles.inputLabel}>{t('investimentos.valorAtualMetaLabel')}</Text>
            <Text style={styles.helperText}>{t('investimentos.helperValorAtualMeta')}</Text>
            <TextInput
              style={styles.input}
              value={novoValorAtualMeta}
              onChangeText={setNovoValorAtualMeta}
              keyboardType="decimal-pad"
              placeholder={t('investimentos.placeholderValorAtualMeta')}
            />

            <Text style={styles.inputLabel}>{t('investimentos.temDataEmMente')}</Text>
            <View style={styles.segmentedControl}>
              <TouchableOpacity
                style={[styles.segmentButton, !metaTemData && styles.segmentButtonActive]}
                onPress={() => setMetaTemData(false)}
              >
                <Text style={[styles.segmentButtonText, !metaTemData && styles.segmentButtonTextActive]}>
                  {t('comum.nao')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentButton, metaTemData && styles.segmentButtonActive]}
                onPress={() => setMetaTemData(true)}
              >
                <Text style={[styles.segmentButtonText, metaTemData && styles.segmentButtonTextActive]}>
                  {t('comum.sim')}
                </Text>
              </TouchableOpacity>
            </View>

            {metaTemData && (
              <>
                <Text style={styles.helperText}>{t('investimentos.helperDataMeta')}</Text>
                <TouchableOpacity style={styles.input} onPress={() => setMostrarSeletorDataMeta(true)}>
                  <Text style={{ fontSize: 14, color: cores.texto }}>{dataParaBR(metaDataSelecionada)}</Text>
                </TouchableOpacity>
                {mostrarSeletorDataMeta && (
                  <SeletorDeData value={metaDataSelecionada} onChange={aoMudarDataMeta} />
                )}
              </>
            )}

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => {
                  limparFormularioMeta();
                  setModalMetaVisivel(false);
                }}
              >
                <Text style={styles.modalCancelButtonText}>{t('comum.cancelar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={salvarMeta}>
                <Text style={styles.modalConfirmButtonText}>{t('comum.salvar')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function TelaDividas() {
  const { estilos: styles, cores } = useTema();
  const { t } = useIdioma();
  const { user } = useAuth();
  const userId = user.id;
  const [dividas, setDividas] = useState(DIVIDAS_INICIAIS);
  const [carregandoDividas, setCarregandoDividas] = useState(true);
  const [estrategia, setEstrategia] = useState('avalanche');
  const [valorExtraTexto, setValorExtraTexto] = useState('300');
  const [modalVisivel, setModalVisivel] = useState(false);

  // Campos do formulário de nova dívida (também usados na edição)
  const [novoNome, setNovoNome] = useState('');
  const [novoSaldo, setNovoSaldo] = useState('');
  const [novaTaxa, setNovaTaxa] = useState('');
  const [novaParcela, setNovaParcela] = useState('');
  const [novoNumeroParcelas, setNovoNumeroParcelas] = useState('');
  // Quando não é null, o modal está EDITANDO essa dívida (em vez de criar uma nova)
  const [dividaEditandoId, setDividaEditandoId] = useState(null);

  // Assim que a tela abre, tenta carregar dívidas que já tinham sido
  // salvas antes. Se não tiver nada salvo ainda (primeira vez usando o
  // app), a lista começa vazia e a pessoa cadastra as dívidas dela.
  useEffect(() => {
    async function carregarDividasSalvas() {
      try {
        const dividasCarregadas = await buscarLinhasDoUsuario(TABELA_DIVIDAS, userId, linhaParaDivida);
        setDividas(dividasCarregadas);
      } catch (erro) {
        console.log('Não foi possível carregar as dívidas salvas:', erro);
      } finally {
        setCarregandoDividas(false);
      }
    }
    carregarDividasSalvas();
  }, [userId]);

  // Toda vez que a lista de dívidas mudar (adicionar/remover), salva de
  // novo no Supabase. O "if (carregandoDividas) return" evita que a gente
  // sobrescreva o que está salvo com os exemplos iniciais bem no instante
  // em que o app está abrindo, antes de terminar de carregar.
  useEffect(() => {
    if (carregandoDividas) return;
    sincronizarLinhasDoUsuario(TABELA_DIVIDAS, userId, dividas, dividaParaLinha).catch((erro) => {
      console.log('Não foi possível salvar as dívidas:', erro);
    });
  }, [dividas, carregandoDividas, userId]);

  // Dívidas já quitadas (saldo zerado ou todas as parcelas pagas) saem da
  // conta de "total devido" e das simulações — elas não competem mais por
  // prioridade nem pelo valor extra.
  const dividasAtivas = dividas.filter((d) => !dividaEstaQuitada(d));
  const dividasQuitadas = dividas.filter((d) => dividaEstaQuitada(d));

  const totalDividas = dividasAtivas.reduce((soma, d) => soma + d.saldoDevedor, 0);
  const dividasOrdenadas = ordenarDividas(dividasAtivas, estrategia);
  const extraMensal = paraNumero(valorExtraTexto);

  const simAvalanche = simularQuitacao(ordenarDividas(dividasAtivas, 'avalanche'), extraMensal);
  const simBolaDeNeve = simularQuitacao(ordenarDividas(dividasAtivas, 'bolaDeNeve'), extraMensal);

  const avalancheEhMaisBarata = simAvalanche.totalJurosPago <= simBolaDeNeve.totalJurosPago;

  // Às vezes a dívida com o MENOR saldo é também a de MAIOR juros (muito
  // comum: cartão de crédito costuma ser a menor dívida e a mais cara).
  // Nesse caso as duas estratégias apontam pra mesma ordem de ataque, e
  // trocar de uma pra outra não muda nada mesmo — não é bug, só coincidência
  // dos números. Avisamos isso pra não parecer que o app tá quebrado.
  const ordemDeAtaqueEhAMesma =
    dividasAtivas.length > 1 &&
    ordenarDividas(dividasAtivas, 'avalanche')
      .map((d) => d.id)
      .join(',') ===
      ordenarDividas(dividasAtivas, 'bolaDeNeve')
        .map((d) => d.id)
        .join(',');

  function confirmarRemocao(id) {
    avisar(t('dividas.confirmarRemocaoTitulo'), t('dividas.confirmarRemocaoMensagem'), [
      { text: t('comum.cancelar'), style: 'cancel' },
      { text: t('comum.remover'), style: 'destructive', onPress: () => {
        setDividas((atual) => atual.filter((d) => d.id !== id));
      }},
    ]);
  }

  function limparFormulario() {
    setNovoNome('');
    setNovoSaldo('');
    setNovaTaxa('');
    setNovaParcela('');
    setNovoNumeroParcelas('');
    setDividaEditandoId(null);
  }

  // Abre o modal já preenchido com os dados da dívida, pra editar
  function abrirEdicaoDivida(divida) {
    setDividaEditandoId(divida.id);
    setNovoNome(divida.nome);
    setNovoSaldo(String(divida.saldoDevedor));
    setNovaTaxa(String(divida.taxaJurosMensal));
    setNovaParcela(String(divida.parcelaMinima));
    setNovoNumeroParcelas(divida.numeroParcelas > 0 ? String(divida.numeroParcelas) : '');
    setModalVisivel(true);
  }

  function salvarDivida() {
    const saldo = paraNumero(novoSaldo);
    const taxa = paraNumero(novaTaxa);
    const parcela = paraNumero(novaParcela);
    const numeroParcelasTexto = novoNumeroParcelas.trim();
    const numeroParcelas = numeroParcelasTexto ? parseInt(numeroParcelasTexto, 10) : 0;

    if (!novoNome.trim()) {
      avisar(t('comum.ops'), t('dividas.erroNome'));
      return;
    }
    if (saldo <= 0) {
      avisar(t('comum.ops'), t('dividas.erroSaldo'));
      return;
    }
    if (parcela <= 0) {
      avisar(t('comum.ops'), t('dividas.erroParcela'));
      return;
    }
    if (numeroParcelasTexto && (isNaN(numeroParcelas) || numeroParcelas <= 0)) {
      avisar(t('comum.ops'), t('dividas.erroNumeroParcelas'));
      return;
    }

    if (dividaEditandoId) {
      // Editando uma dívida que já existia — só atualiza os dados básicos.
      // Parcelas pagas e status do mês continuam do jeito que estavam,
      // isso é controlado pelo botão de confirmar lá na aba Início.
      setDividas((atual) =>
        atual.map((d) =>
          d.id === dividaEditandoId
            ? {
                ...d,
                nome: novoNome.trim(),
                saldoDevedor: saldo,
                taxaJurosMensal: taxa,
                parcelaMinima: parcela,
                numeroParcelas,
              }
            : d
        )
      );
    } else {
      const novaDivida = {
        id: Date.now().toString(),
        nome: novoNome.trim(),
        saldoDevedor: saldo,
        taxaJurosMensal: taxa,
        parcelaMinima: parcela,
        numeroParcelas,
        parcelasPagas: 0,
        ultimoMesConfirmado: null,
        transacaoConfirmadaId: null,
        saldoAntesUltimaParcela: null,
      };
      setDividas((atual) => [...atual, novaDivida]);
    }

    limparFormulario();
    setModalVisivel(false);
  }

  // Enquanto ainda está lendo os dados salvos no celular, mostra uma
  // telinha simples de carregando, pra não "piscar" os exemplos iniciais
  // por um instante antes dos dados reais aparecerem.
  if (carregandoDividas) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>{t('dividas.carregando')}</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.listContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.headerTitle}>{t('dividas.headerTitulo')}</Text>
        <Text style={styles.headerSubtitle}>
          {t('dividas.totalDevido', { valor: formatarMoeda(totalDividas) })}
        </Text>

        {dividasAtivas.length > 0 && (
          <>
            {/* Valor extra mensal — entra na conta das duas simulações abaixo */}
            <Text style={styles.sectionTitle}>{t('dividas.tituloValorExtra')}</Text>
            <Text style={styles.helperText}>{t('dividas.helperValorExtra')}</Text>
            <TextInput
              style={styles.input}
              value={valorExtraTexto}
              onChangeText={setValorExtraTexto}
              keyboardType="decimal-pad"
              placeholder={t('dividas.placeholderValorExtra')}
            />

            {/* A comparação de estratégias só faz sentido com 2 ou mais
                dívidas — com 0 ou 1, não existe "ordem" pra escolher. */}
            {dividasAtivas.length > 1 && (
              <>
                {/* Escolha de estratégia — tocar num card MUDA a ordem de ataque
                    da lista de dívidas logo abaixo. */}
                <Text style={styles.sectionTitle}>{t('dividas.escolhaEstrategia')}</Text>
                <Text style={styles.helperText}>{t('dividas.escolhaEstrategiaHelper')}</Text>

                <View style={styles.comparisonRow}>
                  <TouchableOpacity
                    style={[
                      styles.comparisonCard,
                      avalancheEhMaisBarata && styles.comparisonCardVencedora,
                      estrategia === 'avalanche' && styles.comparisonCardSelecionada,
                    ]}
                    onPress={() => setEstrategia('avalanche')}
                  >
                    {estrategia === 'avalanche' && (
                      <Text style={styles.comparisonSelecionadaBadge}>{t('comum.escolhida')}</Text>
                    )}
                    <Text style={styles.comparisonTitle}>{t('dividas.estrategiaMenorJuros')}</Text>
                    <Text style={styles.comparisonValue}>
                      {simAvalanche.quitouTudo
                        ? t('dividas.resultadoMeses', { meses: simAvalanche.meses })
                        : t('dividas.naoQuitaAssim')}
                    </Text>
                    <Text style={styles.comparisonSubtitle}>
                      {t('dividas.jurosTotal', { valor: formatarMoeda(simAvalanche.totalJurosPago) })}
                    </Text>
                    {avalancheEhMaisBarata && <Text style={styles.comparisonBadge}>{t('dividas.maisBarata')}</Text>}
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.comparisonCard,
                      !avalancheEhMaisBarata && styles.comparisonCardVencedora,
                      estrategia === 'bolaDeNeve' && styles.comparisonCardSelecionada,
                    ]}
                    onPress={() => setEstrategia('bolaDeNeve')}
                  >
                    {estrategia === 'bolaDeNeve' && (
                      <Text style={styles.comparisonSelecionadaBadge}>{t('comum.escolhida')}</Text>
                    )}
                    <Text style={styles.comparisonTitle}>{t('dividas.estrategiaQuitaRapido')}</Text>
                    <Text style={styles.comparisonValue}>
                      {simBolaDeNeve.quitouTudo
                        ? t('dividas.resultadoMeses', { meses: simBolaDeNeve.meses })
                        : t('dividas.naoQuitaAssim')}
                    </Text>
                    <Text style={styles.comparisonSubtitle}>
                      {t('dividas.jurosTotal', { valor: formatarMoeda(simBolaDeNeve.totalJurosPago) })}
                    </Text>
                    {!avalancheEhMaisBarata && <Text style={styles.comparisonBadge}>{t('dividas.maisBarata')}</Text>}
                  </TouchableOpacity>
                </View>

                <Text style={styles.helperText}>
                  {estrategia === 'avalanche'
                    ? t('dividas.descricaoMenorJuros')
                    : t('dividas.descricaoQuitaRapido')}
                </Text>

                {ordemDeAtaqueEhAMesma && (
                  <View style={styles.avisoOrdemIgualBox}>
                    <Ionicons name="information-circle" size={18} color={cores.ambarTexto} />
                    <Text style={styles.avisoOrdemIgualTexto}>{t('dividas.avisoOrdemIgual')}</Text>
                  </View>
                )}
              </>
            )}

            <Text style={styles.sectionTitle}>{t('dividas.ordemDeAtaque')}</Text>
          </>
        )}

        {/* Lista de dívidas, já ordenada pela estratégia escolhida acima.
            A primeira da lista é a que recebe o valor extra todo mês.
            Toque em qualquer uma delas pra editar. */}
        {dividasOrdenadas.map((d, index) => (
          <CardDivida
            key={d.id}
            divida={d}
            posicao={index + 1}
            destaque={index === 0}
            onRemover={confirmarRemocao}
            onEditar={abrirEdicaoDivida}
          />
        ))}

        {dividas.length === 0 && (
          <View style={styles.emptyContainer}>
            <Ionicons name="checkmark-done-circle-outline" size={48} color={cores.textoMuted} />
            <Text style={styles.emptyTitle}>{t('dividas.vazioTitulo')}</Text>
            <Text style={styles.emptySubtitle}>{t('dividas.vazioSubtitulo')}</Text>
          </View>
        )}

        {dividasAtivas.length === 0 && dividasQuitadas.length > 0 && (
          <View style={styles.emptyContainer}>
            <Ionicons name="trophy-outline" size={48} color={cores.verde} />
            <Text style={styles.emptyTitle}>{t('dividas.todasQuitadasTitulo')}</Text>
            <Text style={styles.emptySubtitle}>{t('dividas.todasQuitadasSubtitulo')}</Text>
          </View>
        )}

        <TouchableOpacity style={styles.addButton} onPress={() => setModalVisivel(true)}>
          <Ionicons name="add-circle" size={20} color={cores.primario} />
          <Text style={styles.addButtonText}>{t('dividas.adicionarDivida')}</Text>
        </TouchableOpacity>

        {/* Dívidas já quitadas ficam guardadas aqui embaixo, fora da
            simulação, só como registro */}
        {dividasQuitadas.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('dividas.secaoQuitadas')}</Text>
            {dividasQuitadas.map((d) => (
              <CardDivida
                key={d.id}
                divida={d}
                posicao={null}
                destaque={false}
                onRemover={confirmarRemocao}
                onEditar={abrirEdicaoDivida}
              />
            ))}
          </>
        )}
      </ScrollView>

      {/* Modal pra adicionar ou editar uma dívida */}
      <Modal visible={modalVisivel} animationType="slide" transparent onRequestClose={() => setModalVisivel(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>
              {dividaEditandoId ? t('dividas.modalEditarTitulo') : t('dividas.modalNovaTitulo')}
            </Text>

            <Text style={styles.inputLabel}>{t('comum.nome')}</Text>
            <TextInput
              style={styles.input}
              value={novoNome}
              onChangeText={setNovoNome}
              placeholder={t('dividas.placeholderNome')}
            />

            <Text style={styles.inputLabel}>{t('dividas.labelSaldoDevedorReais')}</Text>
            <TextInput
              style={styles.input}
              value={novoSaldo}
              onChangeText={setNovoSaldo}
              keyboardType="decimal-pad"
              placeholder={t('dividas.placeholderSaldo')}
            />

            <Text style={styles.inputLabel}>{t('dividas.labelTaxaJuros')}</Text>
            <TextInput
              style={styles.input}
              value={novaTaxa}
              onChangeText={setNovaTaxa}
              keyboardType="decimal-pad"
              placeholder={t('dividas.placeholderTaxa')}
            />

            <Text style={styles.inputLabel}>{t('dividas.labelNumeroParcelas')}</Text>
            <TextInput
              style={styles.input}
              value={novoNumeroParcelas}
              onChangeText={setNovoNumeroParcelas}
              keyboardType="number-pad"
              placeholder={t('dividas.placeholderNumeroParcelas')}
            />

            <Text style={styles.inputLabel}>
              {novoNumeroParcelas.trim() ? t('dividas.labelValorParcelaReais') : t('dividas.labelParcelaMinimaReais')}
            </Text>
            <Text style={styles.helperText}>
              {novoNumeroParcelas.trim() ? t('dividas.helperValorParcela') : t('dividas.helperParcelaMinima')}
            </Text>
            <TextInput
              style={styles.input}
              value={novaParcela}
              onChangeText={setNovaParcela}
              keyboardType="decimal-pad"
              placeholder={t('dividas.placeholderParcelaValor')}
            />

            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={styles.modalCancelButton}
                onPress={() => {
                  limparFormulario();
                  setModalVisivel(false);
                }}
              >
                <Text style={styles.modalCancelButtonText}>{t('comum.cancelar')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirmButton} onPress={salvarDivida}>
                <Text style={styles.modalConfirmButtonText}>{t('comum.salvar')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ============================================================
// LOGIN / CADASTRO — tela obrigatória antes de usar o app (Supabase Auth)
// ============================================================
// Traduz as mensagens de erro mais comuns do Supabase Auth pra um
// português mais amigável. Se a mensagem não estiver no mapa, mostra ela
// do jeito que veio (em inglês) — melhor que travar a tela.
function traduzirErroAuth(mensagem) {
  const mapa = {
    'Invalid login credentials': 'E-mail ou senha incorretos.',
    'Email not confirmed': 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada).',
    'User already registered': 'Já existe uma conta com esse e-mail.',
    'A user with this email address has already been registered': 'Já existe uma conta com esse e-mail.',
    'Password should be at least 6 characters': 'A senha precisa ter pelo menos 6 caracteres.',
    'Unable to validate email address: invalid format': 'Digite um e-mail válido.',
  };
  return mapa[mensagem] || mensagem;
}

function TelaLogin() {
  const { estilos: styles, cores, escuro } = useTema();
  const insets = useSafeAreaInsets();

  // "modo" alterna entre entrar numa conta que já existe e criar uma nova
  const [modo, setModo] = useState('login'); // 'login' | 'cadastro'
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [mensagemInfo, setMensagemInfo] = useState(null);

  async function aoConfirmar() {
    const emailLimpo = email.trim();
    setMensagemInfo(null);

    if (!emailLimpo || !senha) {
      avisar('Ops', 'Preencha o e-mail e a senha.');
      return;
    }

    setCarregando(true);
    try {
      if (modo === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email: emailLimpo, password: senha });
        if (error) avisar('Ops', traduzirErroAuth(error.message));
        // Se der certo, o "onAuthStateChange" (lá em App()) já troca a
        // tela sozinho assim que a sessão aparecer — não precisa fazer
        // nada aqui.
      } else {
        const { error } = await supabase.auth.signUp({ email: emailLimpo, password: senha });
        if (error) {
          avisar('Ops', traduzirErroAuth(error.message));
        } else {
          setMensagemInfo(
            'Conta criada! Se pedirmos confirmação por e-mail, dá uma olhada na sua caixa de entrada — senão, você já está logado.'
          );
        }
      }
    } catch (erro) {
      avisar('Ops', 'Não foi possível conectar. Verifique sua internet e tente de novo.');
    } finally {
      setCarregando(false);
    }
  }

  async function aoEsquecerSenha() {
    const emailLimpo = email.trim();
    if (!emailLimpo) {
      avisar('Ops', 'Digite seu e-mail ali em cima e toque em "Esqueci minha senha" de novo.');
      return;
    }
    setMensagemInfo(null);
    setCarregando(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(emailLimpo);
      if (error) {
        avisar('Ops', traduzirErroAuth(error.message));
      } else {
        setMensagemInfo('Se esse e-mail tiver uma conta, enviamos um link pra redefinir a senha. Confira sua caixa de entrada.');
      }
    } catch (erro) {
      avisar('Ops', 'Não foi possível conectar. Verifique sua internet e tente de novo.');
    } finally {
      setCarregando(false);
    }
  }

  function alternarModo() {
    setModo((atual) => (atual === 'login' ? 'cadastro' : 'login'));
    setMensagemInfo(null);
  }

  return (
    <View style={[styles.appContainer, { paddingTop: insets.top }]}>
      <StatusBar style={escuro ? 'light' : 'dark'} />
      <ScrollView
        contentContainerStyle={[
          styles.listContent,
          // No computador, o formulário fica centralizado e com largura
          // limitada (senão os campos ficariam esticados de ponta a ponta
          // da tela). No celular ele continua ocupando a largura toda.
          { flexGrow: 1, justifyContent: 'center', width: '100%', maxWidth: 460, alignSelf: 'center' },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', marginBottom: 32 }}>
          <View
            style={[
              styles.balanceIconWrapper,
              { backgroundColor: cores.primarioFundo, marginBottom: 16 },
            ]}
          >
            <Ionicons name="wallet" size={28} color={cores.primario} />
          </View>
          <Text style={styles.headerTitle}>Meu Financeiro</Text>
          <Text style={[styles.headerSubtitle, { textAlign: 'center' }]}>
            {modo === 'login'
              ? 'Entre na sua conta pra continuar cuidando do seu dinheiro'
              : 'Crie sua conta pra começar a usar o app'}
          </Text>
        </View>

        <Text style={styles.inputLabel}>E-mail</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="seuemail@exemplo.com"
          placeholderTextColor={cores.textoMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!carregando}
        />

        <Text style={styles.inputLabel}>Senha</Text>
        <TextInput
          style={styles.input}
          value={senha}
          onChangeText={setSenha}
          placeholder="Sua senha"
          placeholderTextColor={cores.textoMuted}
          secureTextEntry
          editable={!carregando}
        />

        {mensagemInfo && (
          <View style={[styles.purchaseResultBox, styles.purchaseResultBoxVerde]}>
            <Text style={styles.purchaseResultText}>{mensagemInfo}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.modalConfirmButton, { flex: 0, marginTop: 8 }, carregando && { opacity: 0.7 }]}
          onPress={aoConfirmar}
          disabled={carregando}
        >
          <Text style={styles.modalConfirmButtonText}>
            {carregando ? 'Só um instante...' : modo === 'login' ? 'Entrar' : 'Criar conta'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={{ marginTop: 20, alignItems: 'center' }} onPress={alternarModo} disabled={carregando}>
          <Text style={styles.addButtonText}>
            {modo === 'login' ? 'Ainda não tem conta? Criar conta' : 'Já tem conta? Entrar'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={{ marginTop: 14, alignItems: 'center' }} onPress={aoEsquecerSenha} disabled={carregando}>
          <Text style={[styles.helperText, { textDecorationLine: 'underline', marginBottom: 0 }]}>
            Esqueci minha senha
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ============================================================
// NOVA SENHA — tela que aparece depois do link de "esqueci minha senha"
// ============================================================
// Quando a pessoa clica no link que chegou por e-mail, o Supabase abre
// uma sessão temporária só pra isso. Aqui ela escolhe a senha nova.
function TelaNovaSenha({ aoTerminar }) {
  const { estilos: styles, cores, escuro } = useTema();
  const insets = useSafeAreaInsets();

  const [senha, setSenha] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [carregando, setCarregando] = useState(false);

  async function salvarNovaSenha() {
    if (!senha || !confirmacao) {
      avisar('Ops', 'Preencha a nova senha nos dois campos.');
      return;
    }
    if (senha !== confirmacao) {
      avisar('Ops', 'As duas senhas não são iguais.');
      return;
    }
    if (senha.length < 6) {
      avisar('Ops', 'A senha precisa ter pelo menos 6 caracteres.');
      return;
    }

    setCarregando(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: senha });
      if (error) {
        avisar('Ops', traduzirErroAuth(error.message));
      } else {
        avisar('Pronto!', 'Sua senha foi alterada.');
        aoTerminar();
      }
    } catch (erro) {
      avisar('Ops', 'Não foi possível conectar. Verifique sua internet e tente de novo.');
    } finally {
      setCarregando(false);
    }
  }

  return (
    <View style={[styles.appContainer, { paddingTop: insets.top }]}>
      <StatusBar style={escuro ? 'light' : 'dark'} />
      <ScrollView
        contentContainerStyle={[
          styles.listContent,
          { flexGrow: 1, justifyContent: 'center', width: '100%', maxWidth: 460, alignSelf: 'center' },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', marginBottom: 32 }}>
          <View style={[styles.balanceIconWrapper, { backgroundColor: cores.primarioFundo, marginBottom: 16 }]}>
            <Ionicons name="key" size={28} color={cores.primario} />
          </View>
          <Text style={styles.headerTitle}>Escolher nova senha</Text>
          <Text style={[styles.headerSubtitle, { textAlign: 'center' }]}>
            Digite a senha nova duas vezes pra confirmar
          </Text>
        </View>

        <Text style={styles.inputLabel}>Nova senha</Text>
        <TextInput
          style={styles.input}
          value={senha}
          onChangeText={setSenha}
          placeholder="Pelo menos 6 caracteres"
          placeholderTextColor={cores.textoMuted}
          secureTextEntry
          editable={!carregando}
        />

        <Text style={styles.inputLabel}>Repita a nova senha</Text>
        <TextInput
          style={styles.input}
          value={confirmacao}
          onChangeText={setConfirmacao}
          placeholder="Digite de novo"
          placeholderTextColor={cores.textoMuted}
          secureTextEntry
          editable={!carregando}
        />

        <TouchableOpacity
          style={[styles.modalConfirmButton, { flex: 0, marginTop: 8 }, carregando && { opacity: 0.7 }]}
          onPress={salvarNovaSenha}
          disabled={carregando}
        >
          <Text style={styles.modalConfirmButtonText}>
            {carregando ? 'Salvando...' : 'Salvar nova senha'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ============================================================
// PROVEDOR DE AVISOS — o modal que substitui o Alert no site
// ============================================================
// Fica "por cima" de todo o app. Quando alguma parte do código chama
// "avisar(...)" na versão web, é esse modal aqui que aparece — com o
// mesmo visual (e as mesmas cores de tema) do resto do app.
function ProvedorDeAvisos({ children }) {
  const { estilos: styles, cores } = useTema();
  const [aviso, setAviso] = useState(null);

  useEffect(() => {
    _abrirAvisoNaTela = setAviso;
    return () => {
      _abrirAvisoNaTela = null;
    };
  }, []);

  function fechar() {
    setAviso(null);
  }

  // Se quem chamou não passou botões, mostra só um "OK" que fecha.
  const botoes = aviso && aviso.botoes && aviso.botoes.length > 0 ? aviso.botoes : [{ text: 'OK' }];

  return (
    <>
      {children}
      <Modal visible={aviso !== null} transparent animationType="fade" onRequestClose={fechar}>
        <View style={[styles.modalOverlay, { justifyContent: 'center', padding: 24 }]}>
          <View
            style={[
              styles.modalContent,
              // Em celular ocupa a largura toda; em telas grandes (site no
              // computador) vira uma caixinha centralizada, em vez de uma
              // faixa esticada de ponta a ponta.
              { borderRadius: 20, paddingBottom: 24, width: '100%', maxWidth: 420, alignSelf: 'center' },
            ]}
          >
            {aviso && aviso.titulo ? <Text style={styles.modalTitle}>{aviso.titulo}</Text> : null}
            {aviso && aviso.mensagem ? (
              <Text style={[styles.helperText, { marginBottom: 20 }]}>{aviso.mensagem}</Text>
            ) : null}
            <View style={styles.modalButtonsRow}>
              {botoes.map((botao, indice) => {
                const ehCancelar = botao.style === 'cancel';
                const ehDestrutivo = botao.style === 'destructive';
                return (
                  <TouchableOpacity
                    key={indice}
                    style={[
                      ehCancelar ? styles.modalCancelButton : styles.modalConfirmButton,
                      ehDestrutivo && { backgroundColor: cores.vermelhoTextoForte },
                    ]}
                    onPress={() => {
                      fechar();
                      if (botao.onPress) botao.onPress();
                    }}
                  >
                    <Text style={ehCancelar ? styles.modalCancelButtonText : styles.modalConfirmButtonText}>
                      {botao.text}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

// ============================================================
// APP — junta as duas abas com uma barra de navegação simples
// ============================================================

// Esse componente fica DENTRO do SafeAreaProvider (lá embaixo), porque o
// hook useSafeAreaInsets só funciona dentro dele. É ele quem sabe, de
// verdade, o tamanho da barra de status (em cima) e da barra de
// navegação/gestos do Android (embaixo) em CADA aparelho.
function AppConteudo() {
  const [abaAtiva, setAbaAtiva] = useState('inicio');
  const [modalConfigVisivel, setModalConfigVisivel] = useState(false);
  const insets = useSafeAreaInsets();
  const { estilos: styles, cores, escuro, alternarTema } = useTema();
  const { idioma, setIdioma, t } = useIdioma();

  // "Sair" fecha a sessão no Supabase — o próprio onAuthStateChange (lá em
  // App()) já cuida de trocar a tela pro login assim que isso acontecer,
  // não precisa fazer mais nada por aqui.
  function confirmarSair() {
    avisar(t('config.confirmarSairTitulo'), t('config.confirmarSairMensagem'), [
      { text: t('comum.cancelar'), style: 'cancel' },
      {
        text: t('config.sair'),
        style: 'destructive',
        onPress: () => {
          setModalConfigVisivel(false);
          supabase.auth.signOut();
        },
      },
    ]);
  }

  return (
    <View style={[styles.appContainer, { paddingTop: insets.top }]}>
      <StatusBar style={escuro ? 'light' : 'dark'} />

      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={() => setModalConfigVisivel(true)}
          accessibilityLabel={t('config.abrirConfiguracoes')}
        >
          <Ionicons name="settings-outline" size={26} color={cores.textoSecundario} />
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1 }}>
        {abaAtiva === 'inicio' ? (
          <TelaInicio />
        ) : abaAtiva === 'investimentos' ? (
          <TelaInvestimentos />
        ) : (
          <TelaDividas />
        )}
      </View>

      {/* paddingBottom extra = altura real dos botões/gestos do Android
          nesse aparelho específico, então a barra de abas nunca fica
          escondida atrás deles */}
      <View style={[styles.tabBar, { paddingBottom: insets.bottom + 8 }]}>
        <TouchableOpacity style={styles.tabButton} onPress={() => setAbaAtiva('inicio')}>
          <Ionicons
            name={abaAtiva === 'inicio' ? 'wallet' : 'wallet-outline'}
            size={24}
            color={abaAtiva === 'inicio' ? cores.primario : cores.textoMuted}
          />
          <Text style={[styles.tabLabel, abaAtiva === 'inicio' && styles.tabLabelActive]} numberOfLines={1}>
            {t('abas.inicio')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.tabButton} onPress={() => setAbaAtiva('investimentos')}>
          <Ionicons
            name={abaAtiva === 'investimentos' ? 'trending-up' : 'trending-up-outline'}
            size={24}
            color={abaAtiva === 'investimentos' ? cores.primario : cores.textoMuted}
          />
          <Text style={[styles.tabLabel, abaAtiva === 'investimentos' && styles.tabLabelActive]} numberOfLines={1}>
            {t('abas.investimentos')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.tabButton} onPress={() => setAbaAtiva('dividas')}>
          <Ionicons
            name={abaAtiva === 'dividas' ? 'card' : 'card-outline'}
            size={24}
            color={abaAtiva === 'dividas' ? cores.primario : cores.textoMuted}
          />
          <Text style={[styles.tabLabel, abaAtiva === 'dividas' && styles.tabLabelActive]} numberOfLines={1}>
            {t('abas.dividas')}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Modal de configurações: tela escura e idioma */}
      <Modal
        visible={modalConfigVisivel}
        animationType="slide"
        transparent
        onRequestClose={() => setModalConfigVisivel(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, { marginBottom: 0 }]}>{t('config.titulo')}</Text>
              <TouchableOpacity
                onPress={() => setModalConfigVisivel(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('comum.voltar')}
              >
                <Ionicons name="close" size={24} color={cores.textoSecundario} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>{t('config.aparencia')}</Text>
            <View style={styles.segmentedControl}>
              <TouchableOpacity
                style={[styles.segmentButton, !escuro && styles.segmentButtonActive]}
                onPress={() => escuro && alternarTema()}
              >
                <Text style={[styles.segmentButtonText, !escuro && styles.segmentButtonTextActive]}>
                  {t('config.claro')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.segmentButton, escuro && styles.segmentButtonActive]}
                onPress={() => !escuro && alternarTema()}
              >
                <Text style={[styles.segmentButtonText, escuro && styles.segmentButtonTextActive]}>
                  {t('config.escuro')}
                </Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>{t('config.idioma')}</Text>
            <View style={styles.segmentedControl}>
              {IDIOMAS_DISPONIVEIS.map((opcao) => (
                <TouchableOpacity
                  key={opcao.codigo}
                  style={[styles.segmentButton, idioma === opcao.codigo && styles.segmentButtonActive]}
                  onPress={() => setIdioma(opcao.codigo)}
                >
                  <Text
                    style={[
                      styles.segmentButtonText,
                      { fontSize: 12 },
                      idioma === opcao.codigo && styles.segmentButtonTextActive,
                    ]}
                    numberOfLines={1}
                  >
                    {opcao.bandeira} {opcao.nome}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.inputLabel}>{t('config.conta')}</Text>
            <TouchableOpacity style={styles.logoutButton} onPress={confirmarSair}>
              <Ionicons name="log-out-outline" size={18} color={cores.vermelhoTextoForte} />
              <Text style={styles.logoutButtonText}>{t('config.sair')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.modalCancelButton}
              onPress={() => setModalConfigVisivel(false)}
            >
              <Text style={styles.modalCancelButtonText}>{t('comum.fechar')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const CHAVE_ARMAZENAMENTO_TEMA = '@meu-financeiro:temaEscuro';
const CHAVE_ARMAZENAMENTO_IDIOMA = '@meu-financeiro:idioma';

export default function App() {
  // Começa no modo escuro por padrão. Se a pessoa já tiver escolhido um
  // tema antes (ver useEffect abaixo), a preferência salva é que manda.
  const [escuro, setEscuro] = useState(true);
  const [carregandoTema, setCarregandoTema] = useState(true);
  const [idioma, setIdioma] = useState('pt');
  const [carregandoIdioma, setCarregandoIdioma] = useState(true);

  // Carrega a preferência de tema salva (se o usuário já tinha escolhido
  // tela escura numa sessão anterior).
  useEffect(() => {
    AsyncStorage.getItem(CHAVE_ARMAZENAMENTO_TEMA)
      .then((valorSalvo) => {
        if (valorSalvo !== null) setEscuro(valorSalvo === 'true');
      })
      .finally(() => setCarregandoTema(false));
  }, []);

  // Salva a preferência sempre que ela mudar (menos na primeira renderização,
  // que é só o carregamento inicial).
  useEffect(() => {
    if (carregandoTema) return;
    AsyncStorage.setItem(CHAVE_ARMAZENAMENTO_TEMA, String(escuro));
  }, [escuro, carregandoTema]);

  const alternarTema = () => setEscuro((atual) => !atual);

  const valorTema = {
    escuro,
    cores: escuro ? TEMA_ESCURO : TEMA_CLARO,
    estilos: escuro ? ESTILOS_ESCURO : ESTILOS_CLARO,
    alternarTema,
  };

  // Carrega o idioma salvo (se o usuário já tinha escolhido antes)
  useEffect(() => {
    AsyncStorage.getItem(CHAVE_ARMAZENAMENTO_IDIOMA)
      .then((valorSalvo) => {
        if (valorSalvo !== null) setIdioma(valorSalvo);
      })
      .finally(() => setCarregandoIdioma(false));
  }, []);

  // Salva o idioma sempre que ele mudar (menos no carregamento inicial)
  useEffect(() => {
    if (carregandoIdioma) return;
    AsyncStorage.setItem(CHAVE_ARMAZENAMENTO_IDIOMA, idioma);
  }, [idioma, carregandoIdioma]);

  const valorIdioma = {
    idioma,
    setIdioma,
    t: criarFuncaoTraducao(idioma),
  };

  // ---- Login obrigatório (Supabase Auth) ----
  // "carregandoSessao" cobre só a checagem inicial (existe uma sessão
  // salva no aparelho?). Depois disso, "onAuthStateChange" mantém tudo
  // atualizado sozinho — tanto quando a pessoa entra/cria conta/sai dentro
  // do próprio app quanto se o token expirar e for renovado em segundo
  // plano.
  const [session, setSession] = useState(null);
  const [carregandoSessao, setCarregandoSessao] = useState(true);
  // Fica true só enquanto a pessoa está redefinindo a senha (depois de
  // clicar no link que chegou por e-mail).
  const [redefinindoSenha, setRedefinindoSenha] = useState(false);

  useEffect(() => {
    let ativo = true;

    // No site, o link de "esqueci minha senha" volta com "type=recovery"
    // na própria URL. Olhar isso aqui garante que a tela de nova senha
    // apareça mesmo se o aviso do Supabase (PASSWORD_RECOVERY) demorar.
    if (
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      window.location &&
      (window.location.hash || '').includes('type=recovery')
    ) {
      setRedefinindoSenha(true);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!ativo) return;
      setSession(data.session);
      setCarregandoSessao(false);
    });

    const { data: assinatura } = supabase.auth.onAuthStateChange((evento, novaSessao) => {
      if (!ativo) return;
      // Quando a pessoa clica no link de "esqueci minha senha" que chegou
      // por e-mail, o Supabase avisa aqui com o evento PASSWORD_RECOVERY.
      // Aí, em vez do app normal, mostramos a tela pra escolher a senha
      // nova (ver TelaNovaSenha).
      if (evento === 'PASSWORD_RECOVERY') setRedefinindoSenha(true);
      setSession(novaSessao);
      setCarregandoSessao(false);
    });

    return () => {
      ativo = false;
      assinatura.subscription.unsubscribe();
    };
  }, []);

  const valorAuth = {
    session,
    user: session ? session.user : null,
  };

  // O SafeAreaProvider precisa envolver todo o app pra medir as áreas
  // seguras do aparelho (notch, barra de status, barra de navegação).
  return (
    <SafeAreaProvider>
      <TemaContext.Provider value={valorTema}>
        <IdiomaContext.Provider value={valorIdioma}>
          <ProvedorDeAvisos>
            {carregandoSessao ? (
              <View style={valorTema.estilos.loadingContainer}>
                <Text style={valorTema.estilos.loadingText}>Carregando...</Text>
              </View>
            ) : session && redefinindoSenha ? (
              <TelaNovaSenha aoTerminar={() => setRedefinindoSenha(false)} />
            ) : session ? (
              <AuthContext.Provider value={valorAuth}>
                <AppConteudo />
              </AuthContext.Provider>
            ) : (
              <TelaLogin />
            )}
          </ProvedorDeAvisos>
        </IdiomaContext.Provider>
      </TemaContext.Provider>
    </SafeAreaProvider>
  );
}

// ============================================================
// TEMA (cores) — claro e escuro
// ============================================================
// Em vez de cores fixas espalhadas pelo código, cada cor tem um "nome"
// (ex: cores.texto, cores.fundoCard) e existe uma versão clara e uma
// escura pra cada nome. "criarEstilos" monta o StyleSheet a partir de
// um desses dois conjuntos — é isso que faz a tela escura funcionar.

const TEMA_CLARO = {
  fundo: '#f8fafc',
  fundoCard: '#ffffff',
  fundoSutil: '#f1f5f9',
  texto: '#0f172a',
  textoSecundario: '#64748b',
  textoLabel: '#334155',
  textoMuted: '#94a3b8',
  textoEmptyTitle: '#475569',
  borda: '#e2e8f0',
  overlay: 'rgba(15, 23, 42, 0.5)',
  sombra: '#000',
  branco: '#ffffff',

  primario: '#4338ca',
  primarioFundo: '#eef2ff',
  primarioFundoBorda: '#c7d2fe',

  verde: '#16a34a',
  verdeFundo: '#f0fdf4',
  verdeBorda: '#bbf7d0',
  verdeFundoSuave: '#dcfce7',
  verdeBordaSuave: '#86efac',
  verdeTextoForte: '#166534',

  vermelho: '#dc2626',
  vermelhoFundo: '#fef2f2',
  vermelhoBorda: '#fecaca',
  vermelhoTextoForte: '#991b1b',

  amarelo: '#ca8a04',
  amareloFundo: '#fefce8',

  ambar: '#d97706',
  ambarFundo: '#fffbeb',
  ambarBorda: '#fde68a',
  ambarTextoForte: '#92400e',
  ambarTexto: '#b45309',

  laranjaForte: '#f97316',
  laranjaFundo: '#fff7ed',
  laranjaBorda: '#fdba74',
  laranjaTextoForte: '#7c2d12',
  laranjaTexto: '#9a3412',
};

const TEMA_ESCURO = {
  fundo: '#0f172a',
  fundoCard: '#1e293b',
  fundoSutil: '#273549',
  texto: '#f1f5f9',
  textoSecundario: '#94a3b8',
  textoLabel: '#cbd5e1',
  textoMuted: '#64748b',
  textoEmptyTitle: '#cbd5e1',
  borda: '#334155',
  overlay: 'rgba(0, 0, 0, 0.6)',
  sombra: '#000',
  branco: '#ffffff',

  primario: '#818cf8',
  primarioFundo: '#312e81',
  primarioFundoBorda: '#4338ca',

  verde: '#4ade80',
  verdeFundo: '#052e1a',
  verdeBorda: '#14532d',
  verdeFundoSuave: '#0f2919',
  verdeBordaSuave: '#166534',
  verdeTextoForte: '#86efac',

  vermelho: '#f87171',
  vermelhoFundo: '#2a0a0a',
  vermelhoBorda: '#7f1d1d',
  vermelhoTextoForte: '#fca5a5',

  amarelo: '#eab308',
  amareloFundo: '#2d2a0a',

  ambar: '#f59e0b',
  ambarFundo: '#2a2004',
  ambarBorda: '#78350f',
  ambarTextoForte: '#fcd34d',
  ambarTexto: '#fbbf24',

  laranjaForte: '#f97316',
  laranjaFundo: '#2a1a0a',
  laranjaBorda: '#9a3412',
  laranjaTextoForte: '#fed7aa',
  laranjaTexto: '#fb923c',
};

// Contexto do tema: guarda se está escuro, a paleta de cores atual, os
// estilos prontos pra essa paleta, e a função pra alternar. Qualquer
// componente pode chamar useTema() pra pegar isso, sem precisar receber
// tudo por props.
const TemaContext = React.createContext({
  escuro: false,
  cores: TEMA_CLARO,
  estilos: null,
  alternarTema: () => {},
});

function useTema() {
  return React.useContext(TemaContext);
}

// ============================================================
// AUTENTICAÇÃO (Supabase Auth) — sessão da pessoa logada
// ============================================================
// Guarda a sessão atual (null = ninguém logado) e o usuário dela. Só
// existe valor de verdade aqui DEPOIS do login, porque o próprio App()
// só monta o resto do app (AuthContext.Provider + AppConteudo) quando já
// existe uma sessão — então useAuth() dentro das telas sempre tem um
// "user" válido.
const AuthContext = React.createContext({
  session: null,
  user: null,
});

function useAuth() {
  return React.useContext(AuthContext);
}

// ============================================================
// IDIOMA (traduções) — português, inglês e espanhol
// ============================================================
// Cada texto do app tem uma "chave" (ex: "config.titulo") e um valor
// diferente pra cada idioma dentro de TRADUCOES. A função t(chave) busca
// o texto certo pro idioma atual; se um parâmetro tiver {{assim}} dentro
// do texto, dá pra substituir passando um segundo argumento, tipo
// t('inicio.saldoAtual', { valor: formatarMoeda(saldo) }).

const IDIOMAS_DISPONIVEIS = [
  { codigo: 'pt', nome: 'Português', bandeira: '🇧🇷' },
  { codigo: 'en', nome: 'English', bandeira: '🇺🇸' },
  { codigo: 'es', nome: 'Español', bandeira: '🇪🇸' },
];

function criarFuncaoTraducao(idioma) {
  return function t(chave, params) {
    const partes = chave.split('.');

    let valor = TRADUCOES[idioma];
    for (const parte of partes) valor = valor && valor[parte];

    // Se a chave não existir nesse idioma (ex: uma tradução esquecida),
    // cai pro português em vez de quebrar a tela.
    if (typeof valor !== 'string') {
      valor = TRADUCOES.pt;
      for (const parte of partes) valor = valor && valor[parte];
    }
    if (typeof valor !== 'string') return chave;

    if (!params) return valor;
    return Object.keys(params).reduce(
      (texto, nomeParam) => texto.split(`{{${nomeParam}}}`).join(params[nomeParam]),
      valor
    );
  };
}

const IdiomaContext = React.createContext({
  idioma: 'pt',
  setIdioma: () => {},
  t: criarFuncaoTraducao('pt'),
});

function useIdioma() {
  return React.useContext(IdiomaContext);
}

const TRADUCOES = {
  pt: {
    comum: {
      fechar: 'Fechar',
      voltar: 'Voltar',
      cancelar: 'Cancelar',
      salvar: 'Salvar',
      sim: 'Sim',
      nao: 'Não',
      remover: 'Remover',
      ops: 'Ops',
      nome: 'Nome',
      escolhida: '✓ Escolhida',
      xDeY: '{{x}} de {{y}}',
      mesDeAno: '{{mes}} de {{ano}}',
      meses: {
        '0': 'Janeiro', '1': 'Fevereiro', '2': 'Março', '3': 'Abril', '4': 'Maio', '5': 'Junho',
        '6': 'Julho', '7': 'Agosto', '8': 'Setembro', '9': 'Outubro', '10': 'Novembro', '11': 'Dezembro',
      },
    },
    abas: {
      inicio: 'Início',
      investimentos: 'Investimentos',
      dividas: 'Dívidas',
    },
    config: {
      abrirConfiguracoes: 'Configurações',
      titulo: 'Configurações',
      aparencia: 'Aparência',
      claro: '☀️ Claro',
      escuro: '🌙 Escuro',
      idioma: 'Idioma',
      conta: 'Conta',
      sair: 'Sair',
      confirmarSairTitulo: 'Sair da conta',
      confirmarSairMensagem: 'Tem certeza que quer sair? Você vai precisar entrar de novo com seu e-mail e senha.',
    },
    dividas: {
      saldoDevedor: 'Saldo devedor',
      juros: 'Juros',
      taxaAoMesLinha: '{{taxa}}% a.m. ({{valorJuros}}/mês)',
      valorParcela: 'Valor da parcela',
      parcelaMinima: 'Parcela mínima',
      parcelasPagas: 'Parcelas pagas',
      parcelasPagasFracao: '{{pagas}} de {{total}}',
      dividaQuitada: '🎉 Dívida quitada',
      parcelaPagaEsteMes: '✅ Parcela deste mês já paga (confirme na aba Início)',
      parcelaPendenteEsteMes: '⏳ Parcela deste mês ainda pendente (confirme na aba Início)',
      avisoJurosAltos: 'A parcela não cobre nem os juros do mês — essa dívida só cresce assim.',
      focoAgora: 'Foco agora',
      confirmarRemocaoTitulo: 'Remover dívida',
      confirmarRemocaoMensagem: 'Tem certeza que quer remover essa dívida da lista?',
      erroNome: 'Digite um nome pra essa dívida.',
      erroSaldo: 'O saldo devedor precisa ser maior que zero.',
      erroParcela: 'A parcela mínima precisa ser maior que zero.',
      erroNumeroParcelas: 'O número de parcelas precisa ser maior que zero (ou deixe em branco se não for parcelado, tipo cartão de crédito).',
      carregando: 'Carregando suas dívidas...',
      headerTitulo: 'Minhas Dívidas',
      totalDevido: 'Total devido: {{valor}}',
      tituloValorExtra: 'Quanto a mais você paga por mês?',
      helperValorExtra: 'Além das parcelas mínimas, esse valor extra é usado nas duas simulações abaixo.',
      placeholderValorExtra: 'Ex: 300',
      escolhaEstrategia: 'Escolha sua estratégia',
      escolhaEstrategiaHelper: 'Toque em um dos cards pra escolher. Isso muda a ordem de ataque das suas dívidas, logo abaixo.',
      estrategiaMenorJuros: 'Menor Juros',
      estrategiaQuitaRapido: 'Quita Rápido',
      avisoOrdemIgual: 'Nas suas dívidas de hoje, uma delas tem juntas o menor saldo E o maior juro — por isso as duas estratégias apontam pra mesma ordem de ataque. Isso muda se suas dívidas mudarem.',
      resultadoMeses: '{{meses}} meses',
      naoQuitaAssim: 'não quita assim',
      jurosTotal: 'Juros total: {{valor}}',
      maisBarata: '💰 Mais barata',
      descricaoMenorJuros: 'Ataca primeiro a dívida com a maior taxa de juros. É a estratégia que economiza mais dinheiro no total.',
      descricaoQuitaRapido: 'Ataca primeiro a menor dívida, pra você quitar rápido e ganhar motivação, mesmo pagando um pouco mais de juros no total.',
      ordemDeAtaque: 'Ordem de ataque',
      vazioTitulo: 'Nenhuma dívida cadastrada',
      vazioSubtitulo: 'Toque em "Adicionar dívida" abaixo e coloque as suas de verdade, com o saldo devedor, a taxa de juros e a parcela mínima de cada uma.',
      todasQuitadasTitulo: 'Todas as suas dívidas estão quitadas! 🎉',
      todasQuitadasSubtitulo: 'Cadastre uma nova dívida abaixo se precisar acompanhar outra.',
      adicionarDivida: 'Adicionar dívida',
      secaoQuitadas: 'Dívidas quitadas 🎉',
      modalEditarTitulo: 'Editar dívida',
      modalNovaTitulo: 'Nova dívida',
      placeholderNome: 'Ex: Cartão Nubank',
      labelSaldoDevedorReais: 'Saldo devedor (R$)',
      placeholderSaldo: 'Ex: 1500',
      labelTaxaJuros: 'Taxa de juros mensal (%)',
      placeholderTaxa: 'Ex: 5',
      labelNumeroParcelas: 'Em quantas vezes foi parcelado (opcional)',
      placeholderNumeroParcelas: 'Ex: 12 (deixe em branco se não tiver um número fixo, tipo cartão de crédito)',
      labelValorParcelaReais: 'Valor da parcela (R$)',
      labelParcelaMinimaReais: 'Parcela mínima (R$)',
      helperValorParcela: 'O valor fixo que você paga todo mês até quitar (tipo um financiamento).',
      helperParcelaMinima: 'O mínimo que você pode pagar por mês (tipo cartão de crédito) — pagar só isso não quita, só evita que a dívida cresça ainda mais rápido.',
      placeholderParcelaValor: 'Ex: 200',
    },
    investimentos: {
      tipoLabel: {
        'Reserva de Emergência': 'Reserva de Emergência',
        'Renda Fixa': 'Renda Fixa',
        'Ações': 'Ações',
        'Fundos Imobiliários': 'Fundos Imobiliários',
        'Cripto': 'Cripto',
        'Outro': 'Outro',
      },
      valorInvestidoLabel: 'Valor investido',
      valorAtualLabel: 'Valor atual',
      rendimentoLabel: 'Rendimento',
      metaProgressoLabel: '{{progresso}}% da meta',
      metaAteData: ' · até {{data}}',
      metaAtingida: '🎉 Meta atingida!',
      metaSugestaoComDataSingular: 'Faltam {{faltam}}. Guarde ~{{valorMensal}}/mês pra chegar lá em {{meses}} mês.',
      metaSugestaoComDataPlural: 'Faltam {{faltam}}. Guarde ~{{valorMensal}}/mês pra chegar lá em {{meses}} meses.',
      metaFaltam: 'Faltam {{faltam}}.',
      confirmarRemocaoTitulo: 'Remover investimento',
      confirmarRemocaoMensagem: 'Tem certeza que quer remover esse investimento da lista?',
      erroNome: 'Digite um nome pra esse investimento.',
      erroValorInvestido: 'O valor investido precisa ser maior que zero.',
      erroValorAtual: 'O valor atual não pode ser negativo.',
      confirmarRemocaoMetaTitulo: 'Remover meta',
      confirmarRemocaoMetaMensagem: 'Tem certeza que quer remover essa meta?',
      erroNomeMeta: 'Digite um nome pra essa meta.',
      erroValorAlvoMeta: 'O valor da meta precisa ser maior que zero.',
      erroValorAtualMeta: 'O valor já guardado não pode ser negativo.',
      carregando: 'Carregando seus investimentos...',
      headerTitulo: 'Investimentos',
      totalInvestido: 'Total investido: {{valor}}',
      rendimentoPercentualNoTotal: '{{sinal}}{{percentual}}% no total',
      comoEstaDividido: 'Como está dividido',
      alocacaoLinha: '{{percentual}}% · {{valor}}',
      reservaTitulo: 'Reserva de emergência',
      reservaHelper: 'A recomendação clássica é ter de 3 a 6 meses das suas despesas fixas guardados, pra imprevistos (perder o emprego, um conserto caro, etc). Aqui a meta usa 6 meses. Marque um investimento como "Reserva de Emergência" pra ele contar aqui.',
      reservaProgressoLabel: '{{progresso}}% da meta (6x {{valor}}/mês)',
      reservaSemContasFixas: 'Cadastre suas contas fixas de saída na aba Início pra calcular sua meta de reserva.',
      metasTitulo: 'Metas de economia',
      metasHelper: 'Crie uma meta com um valor e, se quiser, uma data. O app calcula quanto guardar por mês pra chegar lá.',
      metasVazioTitulo: 'Nenhuma meta cadastrada',
      metasVazioSubtitulo: 'Toque em "Adicionar meta" abaixo — pode ser uma viagem, uma reserva, o que você estiver juntando dinheiro pra comprar.',
      adicionarMeta: 'Adicionar meta',
      vazioTitulo: 'Nenhum investimento cadastrado',
      vazioSubtitulo: 'Toque em "Adicionar investimento" abaixo — pode ser sua reserva de emergência, uma renda fixa, ações, o que for.',
      comparadorTitulo: 'Investir ou quitar dívida primeiro?',
      comparadorHelper: 'Toda dívida com juros é um "investimento garantido ao contrário": quitá-la rende, com certeza, a taxa de juros que ela cobra. Compare isso com o quanto você espera que seus investimentos rendam por ano.',
      retornoEsperadoLabel: 'Retorno esperado dos seus investimentos (% ao ano)',
      retornoEsperadoHelper: 'Ninguém sabe esse número ao certo (investimento não tem garantia) — coloque uma estimativa sua, só pra comparar.',
      placeholderTaxa: 'Ex: 10',
      comparadorResultTitulo: '{{nome}} custa ~{{taxa}}% ao ano',
      comparadorResultQuitar: 'Quitar essa dívida "rende" {{diferenca}} pontos a mais, garantido, do que sua expectativa de investimento. Quase sempre compensa mais priorizar quitar essa dívida primeiro.',
      comparadorResultInvestir: 'Seus investimentos podem render mais do que essa dívida custa. Ainda assim, lembre que investimento não tem garantia — e a dívida, se não for paga, com certeza continua cobrando juros.',
      simuladorTitulo: 'Quanto você pode ter no futuro?',
      simuladorHelper: 'Com base no que você já tem investido ({{valor}}) e supondo que você continue aportando todo mês, veja uma estimativa (sem garantia nenhuma — é só uma projeção) de quanto isso pode virar com o tempo.',
      aporteMensalLabel: 'Quanto pretende investir por mês (R$)',
      placeholderAporte: 'Ex: 300',
      emXAnos: 'Em {{anos}} anos',
      meusInvestimentos: 'Meus investimentos',
      adicionarInvestimento: 'Adicionar investimento',
      modalEditarTitulo: 'Editar investimento',
      modalNovoTitulo: 'Novo investimento',
      placeholderNome: 'Ex: Tesouro Selic',
      tipoLabelCampo: 'Tipo',
      valorInvestidoLabelReais: 'Valor investido (R$)',
      helperValorInvestido: 'Quanto você já colocou nesse investimento, no total.',
      placeholderValorInvestido: 'Ex: 1000',
      valorAtualLabelReais: 'Valor atual (R$)',
      helperValorAtual: 'Quanto vale hoje. Se deixar em branco, começa igual ao valor investido.',
      placeholderValorAtual: 'Ex: 1080',
      modalMetaEditarTitulo: 'Editar meta',
      modalMetaNovaTitulo: 'Nova meta',
      placeholderNomeMeta: 'Ex: Viagem pra praia',
      valorAlvoMetaLabel: 'Quanto você quer juntar (R$)',
      placeholderValorAlvoMeta: 'Ex: 3000',
      valorAtualMetaLabel: 'Quanto você já tem guardado (R$)',
      helperValorAtualMeta: 'Se deixar em branco, começa do zero.',
      placeholderValorAtualMeta: 'Ex: 500',
      temDataEmMente: 'Tem uma data em mente?',
      helperDataMeta: 'Com uma data, o app calcula quanto guardar por mês pra chegar lá.',
    },
    inicio: {
      confirmarRemocaoTransacaoTitulo: 'Remover transação',
      confirmarRemocaoTransacaoMensagem: 'Tem certeza que quer remover essa transação?',
      erroDescricao: 'Digite uma descrição pra essa transação.',
      erroValor: 'O valor precisa ser maior que zero.',
      erroNumeroParcelasCompra: 'Digite em quantas vezes foi parcelado (2 ou mais).',
      erroNomeContaFixa: 'Digite um nome pra essa conta fixa.',
      erroDiaContaFixa: 'Digite um dia do mês entre 1 e 28 (pra funcionar em qualquer mês, até fevereiro).',
      confirmarRemocaoContaFixaTitulo: 'Remover conta fixa',
      confirmarRemocaoContaFixaMensagem: 'Tem certeza? Isso não apaga as transações que já foram lançadas antes, só para de lembrar você dela.',
      aindaNaoEntrouNoSaldo: 'ainda não entrou no saldo',
      vazioTitulo: 'Nenhuma transação ainda',
      vazioSubtitulo: 'Suas entradas e saídas vão aparecer aqui',
      nomeApp: 'Meu Financeiro',
      resumoDaConta: 'Resumo da sua conta',
      saldoTotal: 'Saldo Total',
      entradas: 'Entradas',
      saidas: 'Saídas',
      esteMes: 'este mês',
      quantoPossoGastarHoje: 'Quanto posso gastar hoje',
      jaEstourouOMes: 'Já estourou o mês',
      gastoDiarioVerde: 'Tá tranquilo — dentro do esperado pro resto do mês.',
      gastoDiarioAmarelo: 'Atenção: seu ritmo de gasto tá acima do que dá pra sustentar até o fim do mês.',
      gastoDiarioVermelho: 'Você já comprometeu tudo (ou mais) do que tinha disponível esse mês.',
      mesForaPadraoMais: 'Mês fora do padrão: gastando mais',
      mesForaPadraoMenos: 'Mês fora do padrão: gastando menos',
      alertaMesTextoMais: 'Você já gastou {{total}} até hoje, {{percentual}}% a mais que o normal (média de {{media}} até esse mesmo dia).',
      alertaMesTextoMenos: 'Você gastou só {{total}} até hoje, {{percentual}}% a menos que o normal. Mandou bem!',
      possoComprarIssoTitulo: 'Posso comprar isso?',
      possoComprarIssoHelper: 'Digite o valor de uma compra pra ver se ela cabe no seu mês, antes de decidir.',
      placeholderValorCompra: 'Ex: 150',
      aVista: 'À vista',
      parcelado: 'Parcelado',
      emQuantasVezes: 'Em quantas vezes',
      placeholderParcelas: 'Ex: 10',
      impactoCompraVerde: '🟢 Pode comprar tranquilo',
      impactoCompraAmarelo: '🟡 Dá pra comprar, mas com atenção',
      impactoCompraVermelho: '🔴 Melhor não comprar agora',
      impactoCompraTextoVermelho: 'Depois dessa compra, seu mês fica no vermelho (faltariam {{valor}}).',
      impactoCompraTextoOk: 'Depois dessa compra, ainda sobram {{valor}}/dia pro resto do mês.',
      previaDoImpacto: 'Prévia do impacto:',
      vaiApertarBastante: 'vai apertar bastante',
      vaiFicarApertado: 'vai ficar apertado',
      tranquilo: 'tranquilo',
      cadastreRendaFixa: 'Cadastre uma conta fixa de entrada (tipo salário) pra essa prévia considerar sua renda.',
      diaSeguido: 'dia seguido',
      diasSeguidos: 'dias seguidos',
      streakTexto: '{{dias}} {{diaOuDias}} sem estourar',
      comeceSuaSequencia: 'Comece sua sequência hoje!',
      dia: 'dia',
      dias: 'dias',
      recorde: 'Recorde: {{dias}} {{diaOuDias}}',
      novaTransacao: 'Nova transação',
      contasFixasPendentes: 'Contas fixas pendentes',
      entrada: 'Entrada',
      saida: 'Saída',
      deValorTodoDia: 'de {{valor}} · todo dia {{dia}}',
      confirmar: 'Confirmar',
      contasFixas: 'Contas Fixas',
      contasFixasVazio: 'Cadastre contas que se repetem todo mês (tipo salário ou aluguel) e o app avisa quando chegar a hora de lançar.',
      tipoTodoDiaValor: '{{tipo}} · todo dia {{dia}} · {{valor}}',
      recebido: 'Recebido',
      pago: 'Pago',
      adicionarContaFixa: 'Adicionar conta fixa',
      parcelasDeDividas: 'Parcelas de Dívidas',
      parcelasDeDividasVazio: 'Cadastre suas dívidas na aba Dívidas pra acompanhar as parcelas por aqui.',
      parcelaDeValor: 'Parcela de {{valor}}',
      xDeYPagas: '{{pagas}} de {{total}} pagas',
      xPagas: '{{pagas}} pagas',
      maquinaDoTempo: 'Máquina do Tempo',
      maquinaDoTempoVazio: 'Ainda não tenho pelo menos 1 mês fechado de histórico pra fazer uma projeção. Continue registrando suas transações!',
      mediaDosUltimosMeses: 'Nos últimos {{meses}} {{mesOuMeses}}, sua média foi de {{sobraOuDeficit}} de {{valor}} por mês.',
      mes: 'mês',
      meses: 'meses',
      umaSobra: 'uma sobra',
      umDeficit: 'um déficit',
      seContinuarNesseRitmo: 'Se continuar nesse ritmo:',
      em3Meses: 'Em 3 meses',
      em6Meses: 'Em 6 meses',
      historicoDeTransacoes: 'Histórico de Transações',
      carregando: 'Carregando seu financeiro...',
      tipoLabelCampo: 'Tipo',
      descricao: 'Descrição',
      placeholderDescricaoEntrada: 'Ex: Salário, Extras, Freelance...',
      placeholderDescricaoSaida: 'Ex: Mercado, Uber, Aluguel...',
      valorReais: 'Valor (R$)',
      placeholderValorTransacao: 'Ex: 150',
      foiParceladoNoCartao: 'Foi parcelado no cartão?',
      helperParcelasFuturas: 'As parcelas futuras já aparecem no histórico, mas só entram no saldo quando a data de cada uma chegar.',
      data: 'Data',
      editarContaFixa: 'Editar conta fixa',
      novaContaFixa: 'Nova conta fixa',
      placeholderNomeFixaEntrada: 'Ex: Salário',
      placeholderNomeFixaSaida: 'Ex: Aluguel',
      placeholderValorFixa: 'Ex: 1200',
      todoDiaDe1a28: 'Todo dia (1 a 28)',
      placeholderDiaFixa: 'Ex: 5',
      statusDesseMes: 'Status desse mês',
      pendente: 'Pendente',
    },
  },
  en: {
    comum: {
      fechar: 'Close',
      voltar: 'Back',
      cancelar: 'Cancel',
      salvar: 'Save',
      sim: 'Yes',
      nao: 'No',
      remover: 'Remove',
      ops: 'Oops',
      nome: 'Name',
      escolhida: '✓ Selected',
      xDeY: '{{x}} of {{y}}',
      mesDeAno: '{{mes}} {{ano}}',
      meses: {
        '0': 'January', '1': 'February', '2': 'March', '3': 'April', '4': 'May', '5': 'June',
        '6': 'July', '7': 'August', '8': 'September', '9': 'October', '10': 'November', '11': 'December',
      },
    },
    abas: {
      inicio: 'Home',
      investimentos: 'Investments',
      dividas: 'Debts',
    },
    config: {
      abrirConfiguracoes: 'Settings',
      titulo: 'Settings',
      aparencia: 'Appearance',
      claro: '☀️ Light',
      escuro: '🌙 Dark',
      idioma: 'Language',
      conta: 'Account',
      sair: 'Log out',
      confirmarSairTitulo: 'Log out',
      confirmarSairMensagem: 'Are you sure you want to log out? You will need to sign in again with your email and password.',
    },
    dividas: {
      saldoDevedor: 'Outstanding balance',
      juros: 'Interest',
      taxaAoMesLinha: '{{taxa}}% monthly ({{valorJuros}}/month)',
      valorParcela: 'Installment amount',
      parcelaMinima: 'Minimum payment',
      parcelasPagas: 'Installments paid',
      parcelasPagasFracao: '{{pagas}} of {{total}}',
      dividaQuitada: '🎉 Debt paid off',
      parcelaPagaEsteMes: "✅ This month's installment already paid (confirm on the Home tab)",
      parcelaPendenteEsteMes: "⏳ This month's installment still pending (confirm on the Home tab)",
      avisoJurosAltos: "The installment doesn't even cover the month's interest — this debt will only keep growing.",
      focoAgora: 'Focus now',
      confirmarRemocaoTitulo: 'Remove debt',
      confirmarRemocaoMensagem: 'Are you sure you want to remove this debt from the list?',
      erroNome: 'Enter a name for this debt.',
      erroSaldo: 'The outstanding balance needs to be greater than zero.',
      erroParcela: 'The minimum payment needs to be greater than zero.',
      erroNumeroParcelas: "The number of installments needs to be greater than zero (or leave it blank if it's not installment-based, like a credit card).",
      carregando: 'Loading your debts...',
      headerTitulo: 'My Debts',
      totalDevido: 'Total owed: {{valor}}',
      tituloValorExtra: 'How much extra do you pay per month?',
      helperValorExtra: 'Besides the minimum payments, this extra amount is used in the two simulations below.',
      placeholderValorExtra: 'E.g.: 300',
      escolhaEstrategia: 'Choose your strategy',
      escolhaEstrategiaHelper: 'Tap one of the cards to choose. This changes the attack order of your debts, right below.',
      estrategiaMenorJuros: 'Lowest Interest',
      estrategiaQuitaRapido: 'Fastest Payoff',
      avisoOrdemIgual: 'In your current debts, one of them happens to have both the lowest balance AND the highest interest rate — that\'s why both strategies point to the same attack order. This changes if your debts change.',
      resultadoMeses: '{{meses}} months',
      naoQuitaAssim: "won't be paid off this way",
      jurosTotal: 'Total interest: {{valor}}',
      maisBarata: '💰 Cheapest',
      descricaoMenorJuros: 'Attacks the debt with the highest interest rate first. This is the strategy that saves the most money overall.',
      descricaoQuitaRapido: 'Attacks the smallest debt first, so you pay it off quickly and gain motivation, even if you pay a bit more interest overall.',
      ordemDeAtaque: 'Attack order',
      vazioTitulo: 'No debts registered',
      vazioSubtitulo: 'Tap "Add debt" below and add your real ones, with the outstanding balance, interest rate, and minimum payment for each.',
      todasQuitadasTitulo: 'All your debts are paid off! 🎉',
      todasQuitadasSubtitulo: 'Register a new debt below if you need to track another one.',
      adicionarDivida: 'Add debt',
      secaoQuitadas: 'Paid-off debts 🎉',
      modalEditarTitulo: 'Edit debt',
      modalNovaTitulo: 'New debt',
      placeholderNome: 'E.g.: Nubank Card',
      labelSaldoDevedorReais: 'Outstanding balance ($)',
      placeholderSaldo: 'E.g.: 1500',
      labelTaxaJuros: 'Monthly interest rate (%)',
      placeholderTaxa: 'E.g.: 5',
      labelNumeroParcelas: 'Number of installments (optional)',
      placeholderNumeroParcelas: "E.g.: 12 (leave blank if there isn't a fixed number, like a credit card)",
      labelValorParcelaReais: 'Installment amount ($)',
      labelParcelaMinimaReais: 'Minimum payment ($)',
      helperValorParcela: 'The fixed amount you pay every month until it is paid off (like a loan).',
      helperParcelaMinima: "The minimum you can pay per month (like a credit card) — paying only this won't pay it off, it just keeps the debt from growing even faster.",
      placeholderParcelaValor: 'E.g.: 200',
    },
    investimentos: {
      tipoLabel: {
        'Reserva de Emergência': 'Emergency Fund',
        'Renda Fixa': 'Fixed Income',
        'Ações': 'Stocks',
        'Fundos Imobiliários': 'Real Estate Funds',
        'Cripto': 'Crypto',
        'Outro': 'Other',
      },
      valorInvestidoLabel: 'Amount invested',
      valorAtualLabel: 'Current value',
      rendimentoLabel: 'Return',
      metaProgressoLabel: '{{progresso}}% of the goal',
      metaAteData: ' · by {{data}}',
      metaAtingida: '🎉 Goal reached!',
      metaSugestaoComDataSingular: 'You still need {{faltam}}. Save ~{{valorMensal}}/month to get there in {{meses}} month.',
      metaSugestaoComDataPlural: 'You still need {{faltam}}. Save ~{{valorMensal}}/month to get there in {{meses}} months.',
      metaFaltam: 'You still need {{faltam}}.',
      confirmarRemocaoTitulo: 'Remove investment',
      confirmarRemocaoMensagem: 'Are you sure you want to remove this investment from the list?',
      erroNome: 'Enter a name for this investment.',
      erroValorInvestido: 'The amount invested needs to be greater than zero.',
      erroValorAtual: 'The current value cannot be negative.',
      confirmarRemocaoMetaTitulo: 'Remove goal',
      confirmarRemocaoMetaMensagem: 'Are you sure you want to remove this goal?',
      erroNomeMeta: 'Enter a name for this goal.',
      erroValorAlvoMeta: 'The goal amount needs to be greater than zero.',
      erroValorAtualMeta: 'The amount already saved cannot be negative.',
      carregando: 'Loading your investments...',
      headerTitulo: 'Investments',
      totalInvestido: 'Total invested: {{valor}}',
      rendimentoPercentualNoTotal: '{{sinal}}{{percentual}}% overall',
      comoEstaDividido: 'How it is split',
      alocacaoLinha: '{{percentual}}% · {{valor}}',
      reservaTitulo: 'Emergency fund',
      reservaHelper: 'The classic recommendation is to have 3 to 6 months of your fixed expenses saved up, for emergencies (losing your job, an expensive repair, etc). Here the goal uses 6 months. Mark an investment as "Emergency Fund" for it to count here.',
      reservaProgressoLabel: '{{progresso}}% of the goal (6x {{valor}}/month)',
      reservaSemContasFixas: 'Register your fixed expenses on the Home tab to calculate your emergency fund goal.',
      metasTitulo: 'Savings goals',
      metasHelper: 'Create a goal with an amount and, if you want, a date. The app calculates how much to save per month to get there.',
      metasVazioTitulo: 'No goals registered',
      metasVazioSubtitulo: 'Tap "Add goal" below — it can be a trip, a reserve, whatever you\'re saving up money for.',
      adicionarMeta: 'Add goal',
      vazioTitulo: 'No investments registered',
      vazioSubtitulo: 'Tap "Add investment" below — it can be your emergency fund, fixed income, stocks, whatever it may be.',
      comparadorTitulo: 'Invest or pay off debt first?',
      comparadorHelper: 'Every debt with interest is a "guaranteed investment in reverse": paying it off earns you, for sure, the interest rate it charges. Compare that with how much you expect your investments to earn per year.',
      retornoEsperadoLabel: 'Expected return on your investments (% per year)',
      retornoEsperadoHelper: "Nobody knows this number for sure (investments aren't guaranteed) — enter your own estimate, just to compare.",
      placeholderTaxa: 'E.g.: 10',
      comparadorResultTitulo: '{{nome}} costs ~{{taxa}}% per year',
      comparadorResultQuitar: 'Paying off this debt "earns" {{diferenca}} points more, guaranteed, than your investment expectation. It almost always pays off more to prioritize paying off this debt first.',
      comparadorResultInvestir: "Your investments may earn more than this debt costs. Still, remember that investments aren't guaranteed — and the debt, if left unpaid, will definitely keep charging interest.",
      simuladorTitulo: 'How much could you have in the future?',
      simuladorHelper: "Based on what you already have invested ({{valor}}) and assuming you keep contributing every month, see an estimate (no guarantee at all — it's just a projection) of how much that could turn into over time.",
      aporteMensalLabel: 'How much you plan to invest per month ($)',
      placeholderAporte: 'E.g.: 300',
      emXAnos: 'In {{anos}} years',
      meusInvestimentos: 'My investments',
      adicionarInvestimento: 'Add investment',
      modalEditarTitulo: 'Edit investment',
      modalNovoTitulo: 'New investment',
      placeholderNome: 'E.g.: Treasury Bonds',
      tipoLabelCampo: 'Type',
      valorInvestidoLabelReais: 'Amount invested ($)',
      helperValorInvestido: 'How much you have put into this investment in total.',
      placeholderValorInvestido: 'E.g.: 1000',
      valorAtualLabelReais: 'Current value ($)',
      helperValorAtual: "How much it's worth today. If left blank, it starts equal to the amount invested.",
      placeholderValorAtual: 'E.g.: 1080',
      modalMetaEditarTitulo: 'Edit goal',
      modalMetaNovaTitulo: 'New goal',
      placeholderNomeMeta: 'E.g.: Beach trip',
      valorAlvoMetaLabel: 'How much you want to save up ($)',
      placeholderValorAlvoMeta: 'E.g.: 3000',
      valorAtualMetaLabel: 'How much you already have saved ($)',
      helperValorAtualMeta: 'If left blank, it starts at zero.',
      placeholderValorAtualMeta: 'E.g.: 500',
      temDataEmMente: 'Do you have a date in mind?',
      helperDataMeta: 'With a date, the app calculates how much to save per month to get there.',
    },
    inicio: {
      confirmarRemocaoTransacaoTitulo: 'Remove transaction',
      confirmarRemocaoTransacaoMensagem: 'Are you sure you want to remove this transaction?',
      erroDescricao: 'Enter a description for this transaction.',
      erroValor: 'The amount needs to be greater than zero.',
      erroNumeroParcelasCompra: 'Enter the number of installments (2 or more).',
      erroNomeContaFixa: 'Enter a name for this fixed expense.',
      erroDiaContaFixa: 'Enter a day of the month between 1 and 28 (to work in any month, even February).',
      confirmarRemocaoContaFixaTitulo: 'Remove fixed expense',
      confirmarRemocaoContaFixaMensagem: "Are you sure? This won't delete transactions already recorded before, it just stops reminding you about it.",
      aindaNaoEntrouNoSaldo: "hasn't affected the balance yet",
      vazioTitulo: 'No transactions yet',
      vazioSubtitulo: 'Your income and expenses will show up here',
      nomeApp: 'My Finances',
      resumoDaConta: 'Summary of your account',
      saldoTotal: 'Total Balance',
      entradas: 'Income',
      saidas: 'Expenses',
      esteMes: 'this month',
      quantoPossoGastarHoje: 'How much can I spend today',
      jaEstourouOMes: 'Already over budget this month',
      gastoDiarioVerde: "It's all good — within what's expected for the rest of the month.",
      gastoDiarioAmarelo: "Heads up: your spending pace is above what you can sustain until the end of the month.",
      gastoDiarioVermelho: 'You have already committed all (or more) of what you had available this month.',
      mesForaPadraoMais: 'Unusual month: spending more',
      mesForaPadraoMenos: 'Unusual month: spending less',
      alertaMesTextoMais: "You've already spent {{total}} so far, {{percentual}}% more than usual (average of {{media}} up to this same day).",
      alertaMesTextoMenos: "You've only spent {{total}} so far, {{percentual}}% less than usual. Well done!",
      possoComprarIssoTitulo: 'Can I afford this?',
      possoComprarIssoHelper: 'Enter the amount of a purchase to see if it fits your month, before deciding.',
      placeholderValorCompra: 'E.g.: 150',
      aVista: 'One-time',
      parcelado: 'Installments',
      emQuantasVezes: 'How many installments',
      placeholderParcelas: 'E.g.: 10',
      impactoCompraVerde: "🟢 Safe to buy",
      impactoCompraAmarelo: '🟡 You can buy it, but be careful',
      impactoCompraVermelho: "🔴 Better not to buy it right now",
      impactoCompraTextoVermelho: 'After this purchase, your month goes into the red (you would be short {{valor}}).',
      impactoCompraTextoOk: 'After this purchase, you would still have {{valor}}/day left for the rest of the month.',
      previaDoImpacto: 'Impact preview:',
      vaiApertarBastante: "it'll get pretty tight",
      vaiFicarApertado: "it'll get a bit tight",
      tranquilo: 'no problem',
      cadastreRendaFixa: 'Register a fixed income entry (like a salary) for this preview to take your income into account.',
      diaSeguido: 'day in a row',
      diasSeguidos: 'days in a row',
      streakTexto: '{{dias}} {{diaOuDias}} without going over',
      comeceSuaSequencia: 'Start your streak today!',
      dia: 'day',
      dias: 'days',
      recorde: 'Record: {{dias}} {{diaOuDias}}',
      novaTransacao: 'New transaction',
      contasFixasPendentes: 'Pending fixed expenses',
      entrada: 'Income',
      saida: 'Expense',
      deValorTodoDia: 'of {{valor}} · every day {{dia}}',
      confirmar: 'Confirm',
      contasFixas: 'Fixed Expenses',
      contasFixasVazio: 'Register expenses that repeat every month (like salary or rent) and the app will remind you when it is time to record them.',
      tipoTodoDiaValor: '{{tipo}} · every day {{dia}} · {{valor}}',
      recebido: 'Received',
      pago: 'Paid',
      adicionarContaFixa: 'Add fixed expense',
      parcelasDeDividas: 'Debt Installments',
      parcelasDeDividasVazio: 'Register your debts on the Debts tab to track the installments here.',
      parcelaDeValor: 'Installment of {{valor}}',
      xDeYPagas: '{{pagas}} of {{total}} paid',
      xPagas: '{{pagas}} paid',
      maquinaDoTempo: 'Time Machine',
      maquinaDoTempoVazio: "I don't have at least 1 closed month of history yet to make a projection. Keep recording your transactions!",
      mediaDosUltimosMeses: 'Over the last {{meses}} {{mesOuMeses}}, your average was {{sobraOuDeficit}} of {{valor}} per month.',
      mes: 'month',
      meses: 'months',
      umaSobra: 'a surplus',
      umDeficit: 'a deficit',
      seContinuarNesseRitmo: 'If you keep up this pace:',
      em3Meses: 'In 3 months',
      em6Meses: 'In 6 months',
      historicoDeTransacoes: 'Transaction History',
      carregando: 'Loading your finances...',
      tipoLabelCampo: 'Type',
      descricao: 'Description',
      placeholderDescricaoEntrada: 'E.g.: Salary, Bonus, Freelance...',
      placeholderDescricaoSaida: 'E.g.: Groceries, Uber, Rent...',
      valorReais: 'Amount ($)',
      placeholderValorTransacao: 'E.g.: 150',
      foiParceladoNoCartao: 'Was it a card installment purchase?',
      helperParcelasFuturas: "Future installments already show up in the history, but they only affect the balance once each one's date arrives.",
      data: 'Date',
      editarContaFixa: 'Edit fixed expense',
      novaContaFixa: 'New fixed expense',
      placeholderNomeFixaEntrada: 'E.g.: Salary',
      placeholderNomeFixaSaida: 'E.g.: Rent',
      placeholderValorFixa: 'E.g.: 1200',
      todoDiaDe1a28: 'Every day (1 to 28)',
      placeholderDiaFixa: 'E.g.: 5',
      statusDesseMes: "This month's status",
      pendente: 'Pending',
    },
  },
  es: {
    comum: {
      fechar: 'Cerrar',
      voltar: 'Volver',
      cancelar: 'Cancelar',
      salvar: 'Guardar',
      sim: 'Sí',
      nao: 'No',
      remover: 'Eliminar',
      ops: 'Ups',
      nome: 'Nombre',
      escolhida: '✓ Elegida',
      xDeY: '{{x}} de {{y}}',
      mesDeAno: '{{mes}} de {{ano}}',
      meses: {
        '0': 'Enero', '1': 'Febrero', '2': 'Marzo', '3': 'Abril', '4': 'Mayo', '5': 'Junio',
        '6': 'Julio', '7': 'Agosto', '8': 'Septiembre', '9': 'Octubre', '10': 'Noviembre', '11': 'Diciembre',
      },
    },
    abas: {
      inicio: 'Inicio',
      investimentos: 'Inversiones',
      dividas: 'Deudas',
    },
    config: {
      abrirConfiguracoes: 'Configuración',
      titulo: 'Configuración',
      aparencia: 'Apariencia',
      claro: '☀️ Claro',
      escuro: '🌙 Oscuro',
      idioma: 'Idioma',
      conta: 'Cuenta',
      sair: 'Cerrar sesión',
      confirmarSairTitulo: 'Cerrar sesión',
      confirmarSairMensagem: '¿Seguro que quieres cerrar sesión? Vas a tener que entrar de nuevo con tu correo y contraseña.',
    },
    dividas: {
      saldoDevedor: 'Saldo pendiente',
      juros: 'Interés',
      taxaAoMesLinha: '{{taxa}}% mensual ({{valorJuros}}/mes)',
      valorParcela: 'Valor de la cuota',
      parcelaMinima: 'Cuota mínima',
      parcelasPagas: 'Cuotas pagadas',
      parcelasPagasFracao: '{{pagas}} de {{total}}',
      dividaQuitada: '🎉 Deuda saldada',
      parcelaPagaEsteMes: '✅ Cuota de este mes ya pagada (confirma en la pestaña Inicio)',
      parcelaPendenteEsteMes: '⏳ Cuota de este mes aún pendiente (confirma en la pestaña Inicio)',
      avisoJurosAltos: 'La cuota ni siquiera cubre los intereses del mes — esta deuda solo va a crecer así.',
      focoAgora: 'Prioridad ahora',
      confirmarRemocaoTitulo: 'Eliminar deuda',
      confirmarRemocaoMensagem: '¿Estás seguro de que quieres eliminar esta deuda de la lista?',
      erroNome: 'Escribe un nombre para esta deuda.',
      erroSaldo: 'El saldo pendiente debe ser mayor que cero.',
      erroParcela: 'La cuota mínima debe ser mayor que cero.',
      erroNumeroParcelas: 'El número de cuotas debe ser mayor que cero (o déjalo en blanco si no tiene un número fijo, como una tarjeta de crédito).',
      carregando: 'Cargando tus deudas...',
      headerTitulo: 'Mis Deudas',
      totalDevido: 'Total adeudado: {{valor}}',
      tituloValorExtra: '¿Cuánto más pagas por mes?',
      helperValorExtra: 'Además de las cuotas mínimas, este monto extra se usa en las dos simulaciones de abajo.',
      placeholderValorExtra: 'Ej: 300',
      escolhaEstrategia: 'Elige tu estrategia',
      escolhaEstrategiaHelper: 'Toca una de las tarjetas para elegir. Esto cambia el orden de ataque de tus deudas, justo abajo.',
      estrategiaMenorJuros: 'Menor Interés',
      estrategiaQuitaRapido: 'Salda Rápido',
      avisoOrdemIgual: 'En tus deudas de hoy, una de ellas tiene a la vez el saldo más bajo Y el interés más alto — por eso las dos estrategias apuntan al mismo orden de ataque. Esto cambia si tus deudas cambian.',
      resultadoMeses: '{{meses}} meses',
      naoQuitaAssim: 'no se salda así',
      jurosTotal: 'Interés total: {{valor}}',
      maisBarata: '💰 Más barata',
      descricaoMenorJuros: 'Ataca primero la deuda con la tasa de interés más alta. Es la estrategia que ahorra más dinero en total.',
      descricaoQuitaRapido: 'Ataca primero la deuda más pequeña, para que la saldes rápido y ganes motivación, aunque pagues un poco más de interés en total.',
      ordemDeAtaque: 'Orden de ataque',
      vazioTitulo: 'Ninguna deuda registrada',
      vazioSubtitulo: 'Toca "Agregar deuda" abajo y registra las tuyas de verdad, con el saldo pendiente, la tasa de interés y la cuota mínima de cada una.',
      todasQuitadasTitulo: '¡Todas tus deudas están saldadas! 🎉',
      todasQuitadasSubtitulo: 'Registra una nueva deuda abajo si necesitas seguir otra.',
      adicionarDivida: 'Agregar deuda',
      secaoQuitadas: 'Deudas saldadas 🎉',
      modalEditarTitulo: 'Editar deuda',
      modalNovaTitulo: 'Nueva deuda',
      placeholderNome: 'Ej: Tarjeta Nubank',
      labelSaldoDevedorReais: 'Saldo pendiente ($)',
      placeholderSaldo: 'Ej: 1500',
      labelTaxaJuros: 'Tasa de interés mensual (%)',
      placeholderTaxa: 'Ej: 5',
      labelNumeroParcelas: 'En cuántas cuotas (opcional)',
      placeholderNumeroParcelas: 'Ej: 12 (déjalo en blanco si no tiene un número fijo, como una tarjeta de crédito)',
      labelValorParcelaReais: 'Valor de la cuota ($)',
      labelParcelaMinimaReais: 'Cuota mínima ($)',
      helperValorParcela: 'El monto fijo que pagas cada mes hasta saldarla (como un préstamo).',
      helperParcelaMinima: 'El mínimo que puedes pagar por mes (como una tarjeta de crédito) — pagar solo esto no la salda, solo evita que la deuda crezca aún más rápido.',
      placeholderParcelaValor: 'Ej: 200',
    },
    investimentos: {
      tipoLabel: {
        'Reserva de Emergência': 'Fondo de Emergencia',
        'Renda Fixa': 'Renta Fija',
        'Ações': 'Acciones',
        'Fundos Imobiliários': 'Fondos Inmobiliarios',
        'Cripto': 'Cripto',
        'Outro': 'Otro',
      },
      valorInvestidoLabel: 'Monto invertido',
      valorAtualLabel: 'Valor actual',
      rendimentoLabel: 'Rendimiento',
      metaProgressoLabel: '{{progresso}}% de la meta',
      metaAteData: ' · hasta {{data}}',
      metaAtingida: '🎉 ¡Meta alcanzada!',
      metaSugestaoComDataSingular: 'Faltan {{faltam}}. Ahorra ~{{valorMensal}}/mes para llegar en {{meses}} mes.',
      metaSugestaoComDataPlural: 'Faltan {{faltam}}. Ahorra ~{{valorMensal}}/mes para llegar en {{meses}} meses.',
      metaFaltam: 'Faltan {{faltam}}.',
      confirmarRemocaoTitulo: 'Eliminar inversión',
      confirmarRemocaoMensagem: '¿Estás seguro de que quieres eliminar esta inversión de la lista?',
      erroNome: 'Escribe un nombre para esta inversión.',
      erroValorInvestido: 'El monto invertido debe ser mayor que cero.',
      erroValorAtual: 'El valor actual no puede ser negativo.',
      confirmarRemocaoMetaTitulo: 'Eliminar meta',
      confirmarRemocaoMetaMensagem: '¿Estás seguro de que quieres eliminar esta meta?',
      erroNomeMeta: 'Escribe un nombre para esta meta.',
      erroValorAlvoMeta: 'El monto de la meta debe ser mayor que cero.',
      erroValorAtualMeta: 'El monto ya ahorrado no puede ser negativo.',
      carregando: 'Cargando tus inversiones...',
      headerTitulo: 'Inversiones',
      totalInvestido: 'Total invertido: {{valor}}',
      rendimentoPercentualNoTotal: '{{sinal}}{{percentual}}% en total',
      comoEstaDividido: 'Cómo está repartido',
      alocacaoLinha: '{{percentual}}% · {{valor}}',
      reservaTitulo: 'Fondo de emergencia',
      reservaHelper: 'La recomendación clásica es tener de 3 a 6 meses de tus gastos fijos ahorrados, para imprevistos (perder el empleo, una reparación cara, etc). Aquí la meta usa 6 meses. Marca una inversión como "Fondo de Emergencia" para que cuente aquí.',
      reservaProgressoLabel: '{{progresso}}% de la meta (6x {{valor}}/mes)',
      reservaSemContasFixas: 'Registra tus gastos fijos en la pestaña Inicio para calcular tu meta de fondo de emergencia.',
      metasTitulo: 'Metas de ahorro',
      metasHelper: 'Crea una meta con un monto y, si quieres, una fecha. La app calcula cuánto ahorrar por mes para llegar.',
      metasVazioTitulo: 'Ninguna meta registrada',
      metasVazioSubtitulo: 'Toca "Agregar meta" abajo — puede ser un viaje, una reserva, lo que sea que estés ahorrando para comprar.',
      adicionarMeta: 'Agregar meta',
      vazioTitulo: 'Ninguna inversión registrada',
      vazioSubtitulo: 'Toca "Agregar inversión" abajo — puede ser tu fondo de emergencia, renta fija, acciones, lo que sea.',
      comparadorTitulo: '¿Invertir o saldar deuda primero?',
      comparadorHelper: 'Toda deuda con interés es una "inversión garantizada al revés": saldarla rinde, con seguridad, la tasa de interés que cobra. Compara eso con cuánto esperas que tus inversiones rindan por año.',
      retornoEsperadoLabel: 'Rendimiento esperado de tus inversiones (% anual)',
      retornoEsperadoHelper: 'Nadie sabe ese número con certeza (invertir no tiene garantía) — pon una estimación tuya, solo para comparar.',
      placeholderTaxa: 'Ej: 10',
      comparadorResultTitulo: '{{nome}} cuesta ~{{taxa}}% anual',
      comparadorResultQuitar: 'Saldar esta deuda "rinde" {{diferenca}} puntos más, garantizado, que tu expectativa de inversión. Casi siempre conviene más priorizar saldar esta deuda primero.',
      comparadorResultInvestir: 'Tus inversiones pueden rendir más de lo que cuesta esta deuda. Aun así, recuerda que invertir no tiene garantía — y la deuda, si no se paga, seguro que sigue generando intereses.',
      simuladorTitulo: '¿Cuánto podrías tener en el futuro?',
      simuladorHelper: 'Con base en lo que ya tienes invertido ({{valor}}) y suponiendo que sigas aportando cada mes, mira una estimación (sin ninguna garantía — es solo una proyección) de en cuánto podría convertirse con el tiempo.',
      aporteMensalLabel: 'Cuánto piensas invertir por mes ($)',
      placeholderAporte: 'Ej: 300',
      emXAnos: 'En {{anos}} años',
      meusInvestimentos: 'Mis inversiones',
      adicionarInvestimento: 'Agregar inversión',
      modalEditarTitulo: 'Editar inversión',
      modalNovoTitulo: 'Nueva inversión',
      placeholderNome: 'Ej: Bono del Tesoro',
      tipoLabelCampo: 'Tipo',
      valorInvestidoLabelReais: 'Monto invertido ($)',
      helperValorInvestido: 'Cuánto ya has puesto en esta inversión, en total.',
      placeholderValorInvestido: 'Ej: 1000',
      valorAtualLabelReais: 'Valor actual ($)',
      helperValorAtual: 'Cuánto vale hoy. Si lo dejas en blanco, empieza igual al monto invertido.',
      placeholderValorAtual: 'Ej: 1080',
      modalMetaEditarTitulo: 'Editar meta',
      modalMetaNovaTitulo: 'Nueva meta',
      placeholderNomeMeta: 'Ej: Viaje a la playa',
      valorAlvoMetaLabel: 'Cuánto quieres juntar ($)',
      placeholderValorAlvoMeta: 'Ej: 3000',
      valorAtualMetaLabel: 'Cuánto ya tienes ahorrado ($)',
      helperValorAtualMeta: 'Si lo dejas en blanco, empieza en cero.',
      placeholderValorAtualMeta: 'Ej: 500',
      temDataEmMente: '¿Tienes una fecha en mente?',
      helperDataMeta: 'Con una fecha, la app calcula cuánto ahorrar por mes para llegar.',
    },
    inicio: {
      confirmarRemocaoTransacaoTitulo: 'Eliminar transacción',
      confirmarRemocaoTransacaoMensagem: '¿Estás seguro de que quieres eliminar esta transacción?',
      erroDescricao: 'Escribe una descripción para esta transacción.',
      erroValor: 'El monto debe ser mayor que cero.',
      erroNumeroParcelasCompra: 'Escribe en cuántas cuotas se dividió (2 o más).',
      erroNomeContaFixa: 'Escribe un nombre para este gasto fijo.',
      erroDiaContaFixa: 'Escribe un día del mes entre 1 y 28 (para que funcione en cualquier mes, incluso febrero).',
      confirmarRemocaoContaFixaTitulo: 'Eliminar gasto fijo',
      confirmarRemocaoContaFixaMensagem: '¿Estás seguro? Esto no borra las transacciones ya registradas antes, solo deja de recordártelo.',
      aindaNaoEntrouNoSaldo: 'aún no afecta el saldo',
      vazioTitulo: 'Ninguna transacción todavía',
      vazioSubtitulo: 'Tus ingresos y gastos aparecerán aquí',
      nomeApp: 'Mis Finanzas',
      resumoDaConta: 'Resumen de tu cuenta',
      saldoTotal: 'Saldo Total',
      entradas: 'Ingresos',
      saidas: 'Gastos',
      esteMes: 'este mes',
      quantoPossoGastarHoje: 'Cuánto puedo gastar hoy',
      jaEstourouOMes: 'Ya te pasaste del mes',
      gastoDiarioVerde: 'Todo tranquilo — dentro de lo esperado para el resto del mes.',
      gastoDiarioAmarelo: 'Atención: tu ritmo de gasto está por encima de lo que puedes sostener hasta fin de mes.',
      gastoDiarioVermelho: 'Ya comprometiste todo (o más) de lo que tenías disponible este mes.',
      mesForaPadraoMais: 'Mes fuera de lo normal: gastando más',
      mesForaPadraoMenos: 'Mes fuera de lo normal: gastando menos',
      alertaMesTextoMais: 'Ya gastaste {{total}} hasta hoy, un {{percentual}}% más de lo normal (promedio de {{media}} hasta este mismo día).',
      alertaMesTextoMenos: 'Solo gastaste {{total}} hasta hoy, un {{percentual}}% menos de lo normal. ¡Bien hecho!',
      possoComprarIssoTitulo: '¿Puedo comprar esto?',
      possoComprarIssoHelper: 'Escribe el monto de una compra para ver si cabe en tu mes, antes de decidir.',
      placeholderValorCompra: 'Ej: 150',
      aVista: 'Al contado',
      parcelado: 'En cuotas',
      emQuantasVezes: 'En cuántas cuotas',
      placeholderParcelas: 'Ej: 10',
      impactoCompraVerde: '🟢 Puedes comprarlo tranquilo',
      impactoCompraAmarelo: '🟡 Puedes comprarlo, pero con cuidado',
      impactoCompraVermelho: '🔴 Mejor no comprarlo ahora',
      impactoCompraTextoVermelho: 'Después de esta compra, tu mes queda en rojo (te faltarían {{valor}}).',
      impactoCompraTextoOk: 'Después de esta compra, todavía te quedan {{valor}}/día para el resto del mes.',
      previaDoImpacto: 'Vista previa del impacto:',
      vaiApertarBastante: 'se va a apretar bastante',
      vaiFicarApertado: 'se va a poner algo justo',
      tranquilo: 'tranquilo',
      cadastreRendaFixa: 'Registra un ingreso fijo (como un salario) para que esta vista previa considere tu ingreso.',
      diaSeguido: 'día seguido',
      diasSeguidos: 'días seguidos',
      streakTexto: '{{dias}} {{diaOuDias}} sin pasarte',
      comeceSuaSequencia: '¡Empieza tu racha hoy!',
      dia: 'día',
      dias: 'días',
      recorde: 'Récord: {{dias}} {{diaOuDias}}',
      novaTransacao: 'Nueva transacción',
      contasFixasPendentes: 'Gastos fijos pendientes',
      entrada: 'Ingreso',
      saida: 'Gasto',
      deValorTodoDia: 'de {{valor}} · cada día {{dia}}',
      confirmar: 'Confirmar',
      contasFixas: 'Gastos Fijos',
      contasFixasVazio: 'Registra gastos que se repiten cada mes (como salario o alquiler) y la app te avisará cuándo registrarlos.',
      tipoTodoDiaValor: '{{tipo}} · cada día {{dia}} · {{valor}}',
      recebido: 'Recibido',
      pago: 'Pagado',
      adicionarContaFixa: 'Agregar gasto fijo',
      parcelasDeDividas: 'Cuotas de Deudas',
      parcelasDeDividasVazio: 'Registra tus deudas en la pestaña Deudas para seguir las cuotas aquí.',
      parcelaDeValor: 'Cuota de {{valor}}',
      xDeYPagas: '{{pagas}} de {{total}} pagadas',
      xPagas: '{{pagas}} pagadas',
      maquinaDoTempo: 'Máquina del Tiempo',
      maquinaDoTempoVazio: 'Todavía no tengo al menos 1 mes cerrado de historial para hacer una proyección. ¡Sigue registrando tus transacciones!',
      mediaDosUltimosMeses: 'En los últimos {{meses}} {{mesOuMeses}}, tu promedio fue de {{sobraOuDeficit}} de {{valor}} por mes.',
      mes: 'mes',
      meses: 'meses',
      umaSobra: 'un excedente',
      umDeficit: 'un déficit',
      seContinuarNesseRitmo: 'Si sigues a este ritmo:',
      em3Meses: 'En 3 meses',
      em6Meses: 'En 6 meses',
      historicoDeTransacoes: 'Historial de Transacciones',
      carregando: 'Cargando tus finanzas...',
      tipoLabelCampo: 'Tipo',
      descricao: 'Descripción',
      placeholderDescricaoEntrada: 'Ej: Salario, Extras, Freelance...',
      placeholderDescricaoSaida: 'Ej: Supermercado, Uber, Alquiler...',
      valorReais: 'Monto ($)',
      placeholderValorTransacao: 'Ej: 150',
      foiParceladoNoCartao: '¿Se pagó en cuotas con la tarjeta?',
      helperParcelasFuturas: 'Las cuotas futuras ya aparecen en el historial, pero solo afectan el saldo cuando llega la fecha de cada una.',
      data: 'Fecha',
      editarContaFixa: 'Editar gasto fijo',
      novaContaFixa: 'Nuevo gasto fijo',
      placeholderNomeFixaEntrada: 'Ej: Salario',
      placeholderNomeFixaSaida: 'Ej: Alquiler',
      placeholderValorFixa: 'Ej: 1200',
      todoDiaDe1a28: 'Cada día (1 a 28)',
      placeholderDiaFixa: 'Ej: 5',
      statusDesseMes: 'Estado de este mes',
      pendente: 'Pendiente',
    },
  },
};

// ============================================================
// ESTILOS
// ============================================================

function criarEstilos(cores) {
  return StyleSheet.create({
    appContainer: {
      flex: 1,
      backgroundColor: cores.fundo,
    },
    listContent: {
      paddingHorizontal: 20,
      paddingBottom: 24,
    },

    // Barra de cima, só com o botão de configurações no canto direito
    topBar: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: 20,
      paddingTop: 6,
    },

    // Cabeçalho
    headerTitle: {
      fontSize: 26,
      fontWeight: '700',
      color: cores.texto,
      marginTop: Platform.OS === 'android' ? 12 : 4,
    },
    headerSubtitle: {
      fontSize: 14,
      color: cores.textoSecundario,
      marginTop: 2,
      marginBottom: 20,
    },

    // Card de Saldo Total (aba Início)
    balanceCard: {
      backgroundColor: cores.primario,
      borderRadius: 20,
      padding: 22,
      marginBottom: 16,
      shadowColor: cores.primario,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 6,
    },
    balanceIconWrapper: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },
    balanceLabel: {
      fontSize: 14,
      color: 'rgba(255,255,255,0.85)',
      marginBottom: 6,
    },
    balanceValue: {
      fontSize: 32,
      fontWeight: '700',
      color: cores.branco,
    },

    // Cards de Entradas e Saídas (aba Início)
    row: {
      flexDirection: 'row',
      gap: 12,
      marginBottom: 24,
    },
    smallCard: {
      flex: 1,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
    },
    incomeCard: {
      backgroundColor: cores.verdeFundo,
      borderColor: cores.verdeBorda,
    },
    expenseCard: {
      backgroundColor: cores.vermelhoFundo,
      borderColor: cores.vermelhoBorda,
    },
    smallCardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 10,
    },
    smallCardLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: cores.textoLabel,
      marginLeft: 6,
    },
    smallCardValue: {
      fontSize: 18,
      fontWeight: '700',
    },
    smallCardPeriodo: {
      fontSize: 11,
      color: cores.textoMuted,
      marginTop: 2,
    },

    // "Quanto posso gastar hoje" — cartão-semáforo
    dailyBudgetCard: {
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
    },
    dailyBudgetCardVerde: {
      backgroundColor: cores.verdeFundo,
      borderColor: cores.verde,
    },
    dailyBudgetCardAmarelo: {
      backgroundColor: cores.amareloFundo,
      borderColor: cores.amarelo,
    },
    dailyBudgetCardVermelho: {
      backgroundColor: cores.vermelhoFundo,
      borderColor: cores.vermelho,
    },
    dailyBudgetLabel: { fontSize: 13, fontWeight: '600', color: cores.textoLabel },
    dailyBudgetValue: { fontSize: 26, fontWeight: '700', color: cores.texto, marginTop: 4 },
    dailyBudgetSubtitle: { fontSize: 12, color: cores.textoSecundario, marginTop: 6 },

    // "Alerta de mês estranho"
    alertaMesCard: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
    },
    alertaMesCardAlto: {
      backgroundColor: cores.vermelhoFundo,
      borderColor: cores.vermelho,
    },
    alertaMesCardBaixo: {
      backgroundColor: cores.verdeFundo,
      borderColor: cores.verde,
    },
    alertaMesTitulo: { fontSize: 14, fontWeight: '700' },
    alertaMesSubtitulo: { fontSize: 12, marginTop: 2, lineHeight: 17 },

    // "Posso comprar isso?"
    purchaseResultBox: {
      borderRadius: 14,
      padding: 14,
      marginTop: 4,
      marginBottom: 14,
      borderWidth: 1,
    },
    purchaseResultBoxVerde: {
      backgroundColor: cores.verdeFundo,
      borderColor: cores.verde,
    },
    purchaseResultBoxAmarelo: {
      backgroundColor: cores.amareloFundo,
      borderColor: cores.amarelo,
    },
    purchaseResultBoxVermelho: {
      backgroundColor: cores.vermelhoFundo,
      borderColor: cores.vermelho,
    },
    purchaseResultTitle: { fontSize: 14, fontWeight: '700', color: cores.texto },
    purchaseResultText: { fontSize: 12, color: cores.textoSecundario, marginTop: 4, lineHeight: 17 },

    // "Máquina do Tempo" — projeção de saldo
    timeMachineCard: {
      backgroundColor: cores.fundoCard,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    timeMachineTexto: { fontSize: 13, color: cores.textoLabel, marginBottom: 4 },
    timeMachineProjecaoCard: {
      flex: 1,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
    },
    timeMachineProjecaoPositiva: {
      backgroundColor: cores.verdeFundo,
      borderColor: cores.verde,
    },
    timeMachineProjecaoNegativa: {
      backgroundColor: cores.vermelhoFundo,
      borderColor: cores.vermelho,
    },
    timeMachineProjecaoLabel: { fontSize: 12, color: cores.textoSecundario },
    timeMachineProjecaoValor: { fontSize: 16, fontWeight: '700', color: cores.texto, marginTop: 4 },

    // Prévia da compra parcelada (dentro do modal de nova transação)
    previaParcelamentoBox: {
      backgroundColor: cores.fundoSutil,
      borderRadius: 12,
      padding: 12,
      marginTop: 8,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    previaParcelamentoTitulo: { fontSize: 13, fontWeight: '700', color: cores.textoLabel, marginBottom: 6 },
    previaParcelamentoLinha: { fontSize: 13, color: cores.textoLabel, marginTop: 2 },

    // "Sequência sem estourar"
    streakCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: cores.laranjaFundo,
      borderRadius: 16,
      padding: 14,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: cores.laranjaBorda,
    },
    streakTexto: { fontSize: 14, fontWeight: '600', color: cores.laranjaTextoForte },
    streakRecorde: { fontSize: 12, color: cores.laranjaTexto, marginTop: 2 },

    sectionTitle: {
      fontSize: 17,
      fontWeight: '700',
      color: cores.texto,
      marginTop: 8,
      marginBottom: 10,
    },
    helperText: {
      fontSize: 13,
      color: cores.textoSecundario,
      marginBottom: 14,
      lineHeight: 18,
    },

    // Item de transação (aba Início)
    transactionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: cores.fundoCard,
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    transactionItemFutura: {
      opacity: 0.6,
      borderStyle: 'dashed',
    },
    transactionIconWrapper: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: cores.fundoSutil,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    transactionInfo: { flex: 1 },
    transactionTitle: { fontSize: 14, fontWeight: '600', color: cores.texto },
    transactionDate: { fontSize: 12, color: cores.textoMuted, marginTop: 2 },
    transactionValue: { fontSize: 14, fontWeight: '700' },

    emptyContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 48,
    },
    emptyTitle: { fontSize: 15, fontWeight: '600', color: cores.textoEmptyTitle, marginTop: 12 },
    emptySubtitle: { fontSize: 13, color: cores.textoMuted, marginTop: 4, textAlign: 'center' },

    loadingContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: cores.fundo,
    },
    loadingText: { fontSize: 14, color: cores.textoMuted },

    // Título de cada mês no histórico agrupado
    monthSectionHeader: {
      fontSize: 13,
      fontWeight: '700',
      color: cores.textoSecundario,
      textTransform: 'uppercase',
      marginTop: 12,
      marginBottom: 8,
    },

    // Aviso de conta fixa pendente de confirmação
    pendingCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: cores.ambarFundo,
      borderWidth: 1,
      borderColor: cores.ambarBorda,
      borderRadius: 14,
      padding: 12,
      marginBottom: 10,
    },
    pendingTitle: { fontSize: 14, fontWeight: '700', color: cores.ambarTextoForte },
    pendingSubtitle: { fontSize: 12, color: cores.ambarTexto, marginTop: 2 },
    pendingButton: {
      backgroundColor: cores.ambar,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
    },
    pendingButtonText: { fontSize: 12, fontWeight: '700', color: cores.branco },

    // Card de conta fixa cadastrada
    fixedBillCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: cores.fundoCard,
      borderRadius: 14,
      padding: 14,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    fixedBillTitle: { fontSize: 14, fontWeight: '600', color: cores.texto },
    fixedBillSubtitle: { fontSize: 12, color: cores.textoSecundario, marginTop: 2 },
    // Botão grande de confirmar/desmarcar recebimento ou pagamento
    confirmToggleButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 12,
      gap: 6,
    },
    confirmToggleButtonPendente: {
      backgroundColor: cores.laranjaForte,
    },
    confirmToggleButtonOk: {
      backgroundColor: cores.verdeFundoSuave,
      borderWidth: 1,
      borderColor: cores.verdeBordaSuave,
    },
    confirmToggleButtonText: {
      fontSize: 13,
      fontWeight: '700',
      color: cores.branco,
    },
    confirmToggleButtonTextOk: {
      color: cores.verdeTextoForte,
    },

    // Segmented control (Menor Juros / Quita Rápido)
    segmentedControl: {
      flexDirection: 'row',
      backgroundColor: cores.borda,
      borderRadius: 12,
      padding: 4,
      marginBottom: 10,
    },
    segmentButton: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 9,
      alignItems: 'center',
    },
    segmentButtonActive: {
      backgroundColor: cores.fundoCard,
      shadowColor: cores.sombra,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
    },
    segmentButtonText: { fontSize: 13, fontWeight: '600', color: cores.textoSecundario },
    segmentButtonTextActive: { color: cores.primario },

    // Card de dívida
    debtCard: {
      backgroundColor: cores.fundoCard,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    debtCardDestaque: {
      borderColor: cores.primario,
      borderWidth: 2,
    },
    debtCardQuitada: {
      opacity: 0.7,
      backgroundColor: cores.fundo,
    },
    debtCardTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 10,
    },
    debtBadge: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: cores.primarioFundo,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    debtBadgeText: { fontSize: 13, fontWeight: '700', color: cores.primario },
    debtName: { fontSize: 15, fontWeight: '700', color: cores.texto },
    debtFocoLabel: { fontSize: 12, color: cores.primario, fontWeight: '600', marginTop: 2 },
    debtInfoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 4,
    },
    debtInfoLabel: { fontSize: 13, color: cores.textoSecundario },
    debtInfoValue: { fontSize: 13, fontWeight: '600', color: cores.textoLabel },
    debtStatusMesTexto: { fontSize: 12, color: cores.textoSecundario, marginTop: 8 },
    debtWarningBox: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: cores.ambarFundo,
      borderRadius: 10,
      padding: 8,
      marginTop: 10,
      gap: 6,
    },
    debtWarningText: { flex: 1, fontSize: 12, color: cores.ambarTextoForte },
    avisoOrdemIgualBox: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: cores.ambarFundo,
      borderRadius: 10,
      padding: 10,
      marginTop: 10,
      gap: 8,
    },
    avisoOrdemIgualTexto: { flex: 1, fontSize: 12, color: cores.ambarTextoForte },

    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: cores.primarioFundoBorda,
      borderStyle: 'dashed',
      borderRadius: 14,
      paddingVertical: 14,
      marginBottom: 24,
      gap: 8,
    },
    addButtonText: { fontSize: 14, fontWeight: '600', color: cores.primario },

    input: {
      backgroundColor: cores.fundoCard,
      borderWidth: 1,
      borderColor: cores.borda,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      color: cores.texto,
      marginBottom: 14,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: cores.textoLabel,
      marginBottom: 6,
    },

    comparisonRow: {
      flexDirection: 'row',
      gap: 12,
      marginBottom: 8,
    },
    comparisonCard: {
      flex: 1,
      backgroundColor: cores.fundoCard,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    comparisonCardVencedora: {
      borderColor: cores.verde,
      borderWidth: 2,
      backgroundColor: cores.verdeFundo,
    },
    comparisonCardSelecionada: {
      borderColor: cores.primario,
      borderWidth: 2,
      backgroundColor: cores.primarioFundo,
    },
    comparisonSelecionadaBadge: {
      fontSize: 11,
      fontWeight: '700',
      color: cores.primario,
      marginBottom: 4,
    },
    comparisonTitle: { fontSize: 13, fontWeight: '700', color: cores.texto, marginBottom: 6 },
    comparisonValue: { fontSize: 18, fontWeight: '700', color: cores.texto },
    comparisonSubtitle: { fontSize: 12, color: cores.textoSecundario, marginTop: 4 },
    comparisonBadge: { fontSize: 12, fontWeight: '700', color: cores.verdeTextoForte, marginTop: 8 },

    // Aba Investimentos — card de cada investimento
    investCard: {
      backgroundColor: cores.fundoCard,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    investCardTopRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    investName: { fontSize: 15, fontWeight: '700', color: cores.texto, marginBottom: 6 },
    investTipoBadge: {
      alignSelf: 'flex-start',
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    investTipoBadgeText: { fontSize: 11, fontWeight: '700' },

    // Barra de alocação por tipo (empilhada) e legenda embaixo dela
    allocationBarContainer: {
      flexDirection: 'row',
      height: 14,
      borderRadius: 8,
      overflow: 'hidden',
      backgroundColor: cores.fundoSutil,
      marginBottom: 12,
    },
    allocationLegendRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 8,
    },
    allocationLegendDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      marginRight: 8,
    },
    allocationLegendText: { flex: 1, fontSize: 13, color: cores.textoLabel },
    allocationLegendPercent: { fontSize: 13, fontWeight: '600', color: cores.texto },

    // Card da meta de reserva de emergência
    reserveCard: {
      backgroundColor: cores.fundoCard,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    reserveValueText: { fontSize: 17, fontWeight: '700', color: cores.texto, marginBottom: 10 },
    reserveProgressTrack: {
      height: 12,
      borderRadius: 6,
      backgroundColor: cores.fundoSutil,
      overflow: 'hidden',
      marginBottom: 6,
    },
    reserveProgressFill: {
      height: 12,
      borderRadius: 6,
      backgroundColor: cores.primario,
    },
    reserveProgressLabel: { fontSize: 12, color: cores.textoSecundario },

    // Chips (seletor de tipo de investimento, seletor de dívida no comparador)
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 14,
    },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: cores.fundoSutil,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    chipActive: {
      backgroundColor: cores.primarioFundo,
      borderColor: cores.primario,
    },
    chipText: { fontSize: 13, color: cores.textoSecundario, fontWeight: '600' },
    chipTextActive: { color: cores.primario },

    // Resultado do comparador "investir ou quitar dívida?"
    comparadorResultBox: {
      borderRadius: 14,
      padding: 14,
      borderWidth: 1,
      marginBottom: 14,
      gap: 4,
    },
    comparadorResultBoxQuitar: {
      backgroundColor: cores.ambarFundo,
      borderColor: cores.ambarBorda,
    },
    comparadorResultBoxInvestir: {
      backgroundColor: cores.verdeFundo,
      borderColor: cores.verdeBorda,
    },
    comparadorResultTitle: { fontSize: 14, fontWeight: '700' },
    comparadorResultText: { fontSize: 12, lineHeight: 17 },

    // Simulador de futuro/aposentadoria (aba Investimentos)
    simuladorFuturoCard: {
      flex: 1,
      borderRadius: 12,
      padding: 12,
      borderWidth: 1,
      backgroundColor: cores.primarioFundo,
      borderColor: cores.primarioFundoBorda,
    },
    simuladorFuturoLabel: { fontSize: 12, color: cores.textoSecundario },
    simuladorFuturoValor: { fontSize: 16, fontWeight: '700', color: cores.texto, marginTop: 4 },

    // Metas de economia (aba Investimentos)
    metaCard: {
      backgroundColor: cores.fundoCard,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: cores.borda,
    },
    metaCardTopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    metaName: { fontSize: 15, fontWeight: '700', color: cores.texto, flex: 1, marginRight: 8 },
    metaValorText: { fontSize: 14, fontWeight: '600', color: cores.textoLabel, marginBottom: 8 },
    metaProgressTrack: {
      height: 12,
      borderRadius: 6,
      backgroundColor: cores.fundoSutil,
      overflow: 'hidden',
      marginBottom: 6,
    },
    metaProgressFill: {
      height: 12,
      borderRadius: 6,
      backgroundColor: cores.primario,
    },
    metaProgressFillCompleta: {
      backgroundColor: cores.verde,
    },
    metaProgressLabel: { fontSize: 12, color: cores.textoSecundario, marginBottom: 6 },
    metaAtingidaTexto: { fontSize: 13, fontWeight: '700', color: cores.verdeTextoForte },
    metaSugestaoTexto: { fontSize: 12, color: cores.textoSecundario, lineHeight: 17 },

    // Modal de nova dívida
    modalOverlay: {
      flex: 1,
      backgroundColor: cores.overlay,
      justifyContent: 'flex-end',
    },
    modalContent: {
      backgroundColor: cores.fundoCard,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      padding: 24,
      paddingBottom: 32,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: cores.texto,
      marginBottom: 16,
    },
    modalHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 16,
    },
    modalButtonsRow: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 8,
    },
    modalCancelButton: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
      backgroundColor: cores.fundoSutil,
    },
    modalCancelButtonText: { fontSize: 14, fontWeight: '600', color: cores.textoLabel },
    modalConfirmButton: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
      backgroundColor: cores.primario,
    },
    modalConfirmButtonText: { fontSize: 14, fontWeight: '600', color: cores.branco },

    // Botão de "Sair" (logout), no modal de configurações
    logoutButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 14,
      borderRadius: 12,
      backgroundColor: cores.vermelhoFundo,
      borderWidth: 1,
      borderColor: cores.vermelhoBorda,
      marginBottom: 16,
    },
    logoutButtonText: { fontSize: 14, fontWeight: '600', color: cores.vermelhoTextoForte },

    // Barra de abas (feita na mão, sem biblioteca)
    tabBar: {
      flexDirection: 'row',
      borderTopWidth: 1,
      borderTopColor: cores.borda,
      backgroundColor: cores.fundoCard,
      paddingTop: 8,
      // o paddingBottom "de verdade" é somado dinamicamente no componente,
      // com base no insets.bottom de cada aparelho
    },
    tabButton: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
    },
    tabLabel: { fontSize: 10, color: cores.textoMuted, fontWeight: '600' },
    tabLabelActive: { color: cores.primario },
  });
}

const ESTILOS_CLARO = criarEstilos(TEMA_CLARO);
const ESTILOS_ESCURO = criarEstilos(TEMA_ESCURO);
