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
<<<<<<< HEAD
  // rc.45: Feishu/Lark e DingTalk (o aplicativo interno da empresa)
  'canal.grupoTexto': 'Teams, Telegram, Discord, Feishu/Lark या DingTalk पर टीम से बात करें।',
  'canal.titulo.feishu': 'Feishu या Lark पर टीम से बात करें',
  'canal.titulo.dingtalk': 'DingTalk पर टीम से बात करें',
  'canal.app.intro': 'अपनी कंपनी के ऐप के बॉट से सीधी बातचीत में टीम को अनुरोध भेजें और जवाब वहीं पाएँ। कनेक्शन आपके कंप्यूटर से बाहर जाता है, किसी सार्वजनिक पते के बिना। पुष्टियाँ टेक्स्ट के रूप में आती हैं, और फ़ैसला आप Ergon में करते हैं।',
  'canal.app.dominio': 'आपकी कंपनी कहाँ इस्तेमाल करती है',
  'canal.app.feishu': 'Feishu (चीन) · open.feishu.cn',
  'canal.app.lark': 'Lark (अंतरराष्ट्रीय) · open.larksuite.com',
  'canal.app.id': 'App ID',
  'canal.app.idDt': 'Client ID (AppKey)',
  'canal.app.segredo': 'App Secret',
  'canal.app.segredoDt': 'Client Secret (AppSecret)',
  'canal.app.guardado': 'App Secret आपकी टीम के पास सुरक्षित रहता है और इस स्क्रीन पर फिर नहीं दिखता। कोई भी एजेंट इसे बातचीत में कभी नहीं माँगता।',
  'canal.app.console': 'डेवलपर कंसोल',
  'canal.fs.passo1': '{console} खोलें और अपनी कंपनी के लिए कस्टम ऐप बनाएँ (Create Custom App)। Add Features में Bot चालू करें।',
  'canal.fs.passo2': 'Credentials & Basic Info में App ID और App Secret कॉपी करके नीचे पेस्ट करें।',
  'canal.fs.passo3': 'जब "Connected" दिखे, कंसोल पर लौटें: Events & Callbacks में persistent connection (long connection) से इवेंट लेना चुनें और "Receive messages" (im.message.receive_v1) जोड़ें।',
  'canal.fs.passo4': 'Permissions & Scopes में सीधे संदेश पढ़ने और भेजने की अनुमति दें (im:message.p2p_msg:readonly और im:message:send_as_bot)। कंपनी की मंज़ूरी के लिए ऐप का एक संस्करण प्रकाशित करें।',
  'canal.dt.passo1': 'DingTalk का {console} खोलें और अपनी कंपनी के लिए आंतरिक ऐप बनाएँ (Create App)।',
  'canal.dt.passo2': 'Add Capability में Robot जोड़ें और Message Receiving Mode में Stream Mode चुनें।',
  'canal.dt.passo3': 'Credentials & Basic Info में Client ID और Client Secret कॉपी करके नीचे पेस्ट करें।',
  'canal.dt.passo4': 'रोबोट प्रकाशित करें (Publish)। DingTalk में रोबोट को नाम से खोजें और उससे सीधी बातचीत शुरू करें।',
  'canal.app.parear.passo': 'अब रोबोट को सीधी बातचीत में कोई भी संदेश भेजें। वह 8 अक्षरों और अंकों का एक कोड भेजेगा: उसे यहाँ लिखें।',
  'canal.app.parear.codigo': 'रोबोट का भेजा कोड',
  'canal.app.trocar': 'दूसरा ऐप इस्तेमाल करें',
  'canal.app.desligarPergunta': 'बंद करें? App ID और App Secret आपकी टीम से हट जाएँगे और संदेश आना बंद हो जाएगा। वापस लाने के लिए फिर से पेस्ट करें।',
  'canal.app.codigoRecusado': '{canal} ने App ID या App Secret अस्वीकार कर दिया। जाँचें कि पूरा कॉपी किया है, या "दूसरा ऐप इस्तेमाल करें" चुनें।',
  'canal.app.conectando': 'ऐप जोड़ा जा रहा है। कोशिशें अपने-आप जारी रहेंगी।',
  'canal.app.semConexao': 'अभी कनेक्शन नहीं है। इंटरनेट, App ID और App Secret जाँचें; कोशिशें अपने-आप जारी रहेंगी।',
  'canal.fechado.feishu': 'Ergon बंद रहने पर Feishu संदेश नहीं पहुँचाता: रोबोट जवाब नहीं देता, और उस दौरान भेजा गया संदेश नहीं पहुँचता। Ergon खुला होने पर फिर से भेजें।',
  'canal.fechado.dingtalk': 'Ergon बंद रहने पर DingTalk संदेश नहीं पहुँचाता। और रोबोट आपके आख़िरी संदेश के कुछ समय बाद तक ही जवाब दे सकता है: उसके बाद की सूचना आपके फिर से लिखने का इंतज़ार करती है।',
  'canal.app.soDireta': 'सिर्फ़ रोबोट से सीधी बातचीत काम करती है (समूह नहीं), और अभी केवल टेक्स्ट। मंज़ूर या अस्वीकार करने के लिए Ergon खोलें।',
  'canal.app.pronto': 'हो गया: रोबोट को लिखें, और अनुरोध आपकी टीम तक पहुँचेगा।',
  'canal.erro.formato_app': 'App ID या App Secret का स्वरूप सही नहीं है। दोबारा पूरा कॉपी करें।',
=======
>>>>>>> origin/main
};

export default conexoes;
