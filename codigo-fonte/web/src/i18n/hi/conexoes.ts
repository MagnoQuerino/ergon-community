// Área "conexoes" em hindi (hi): PARCIAL (a chave que falta vem do inglês). Tipada pelo português.
// REVISÃO POR NATIVO PENDENTE: tradução gerada na rc.44 a partir do inglês, com o glossário de ../GLOSSARIO.md;
// precisa da revisão de um falante nativo antes da versão final (COMO-TRADUZIR.md, "Chinês e hindi").
import type pt from '../pt/conexoes.ts';
import type { TraducaoParcial } from '../tipos.ts';

export const REVISAO_NATIVA_PENDENTE = true;

const conexoes: TraducaoParcial<typeof pt> = {
  'titulo': 'कनेक्शन',
  'intro': 'एजेंटों को चलाने वाला AI खाता, और वे ऐप और चैनल जिन्हें टीम आपकी ओर से इस्तेमाल करती है। क्रेडेंशियल सिर्फ़ इस कंप्यूटर पर, एन्क्रिप्ट होकर रहते हैं; ब्राउज़र में कभी नहीं।',
  'acao.fechar': 'बंद करें',
  'acao.cancelar': 'रद्द करें',
  'acao.salvar': 'सहेजें',
  'acao.desligar': 'बंद करें',
  'acao.conferindo': 'जाँच हो रही है…',
  'acao.autorizarDeNovo': 'फिर से अनुमति दें',
  'acao.outraConta': 'इस खाते को दूसरे से बदलें',
  'estado.off': 'जुड़ा नहीं',
  'estado.pending': 'जुड़ रहा है…',
  'estado.connected': 'जुड़ा है',
  'estado.error': 'ध्यान चाहिए',
  'estado.soon': 'जल्द आ रहा है',
  'estado.indisponivel': 'अभी उपलब्ध नहीं',
  'estado.semConexao': 'ऑफ़लाइन',
  'detalhes': 'विवरण',
  'secao.tarefas.titulo': 'कार्य और बोर्ड',
  'secao.tarefas.texto': 'कार्य में सूची या बोर्ड चुनें: यह दोनों तरफ़ सिंक रहता है।',
  'secao.conversas.titulo': 'चैट और टीमें',
  'secao.conversas.texto': 'एजेंट वह पढ़ते हैं जिस तक खाते की पहुँच है और आपके कहने पर जवाब देते हैं।',
  'secao.vendas.titulo': 'बिक्री और सहायता',
  'secao.vendas.texto': 'ग्राहक, सौदे और टिकट: एजेंट इन्हें देखते हैं और जो आप तय करें उसे दर्ज करते हैं।',
  'secao.documentos.titulo': 'दस्तावेज़, कोड और कैलेंडर',
  'secao.documentos.texto': 'वे पेज, रिपॉज़िटरी और कैलेंडर जिन तक क्रेडेंशियल पहुँच सकता है।',
  'secao.financeiro.titulo': 'वित्त',
  'secao.financeiro.texto': 'आपके कहने पर जानकारी, ग्राहक और भुगतान माँगना। यहाँ से कुछ भी भुगतान या ट्रांसफ़र नहीं होता।',
  'ia.titulo': 'AI खाते',
  'ia.texto': 'वह खाता जो एजेंटों के मॉडल का भुगतान करता है।',
  'busca.placeholder': 'खोजें (उदा. Slack, Trello, HubSpot)',
  'busca.aria': 'ऐप खोजें',
  'busca.todos': 'सभी ({n})',
  'busca.conectados': 'जुड़े हुए ({n})',
};

export default conexoes;
