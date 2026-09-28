# Chá Rifa da Laurinha 💕

Rifa online de 200 números para o chá de bebê da Laurinha. Cada número vale **1 pacote de fralda + 1 mimo** ou um **Pix a partir de R$ 30**.

O site é estático e roda no **GitHub Pages**. Os dados ficam no **Firebase (Firestore)** e atualizam em tempo real para todo mundo.

## Como funciona

- **Participante:** escolhe os números, informa o nome e a forma de contribuição, e toca em **Reservar**. Os números ficam reservados na hora e aparecem ocupados para todos. Em seguida, envia a mensagem pronta pelo WhatsApp e faz o Pix, se for o caso.
- **Organizador:** entra com a conta Google em **Área do organizador** (link no rodapé). No painel, confirma pagamentos, edita ou libera números, altera as configurações, faz o sorteio e exporta a planilha.
- **Concorrência:** se duas pessoas tentarem o mesmo número ao mesmo tempo, o Firestore garante que só a primeira reserva vale.

## Estrutura

```
index.html          estrutura da página
style.css           visual (cores nas variáveis do :root)
script.js           lógica: página pública, painel, Firebase
firebase-config.js  credenciais do app Web e e-mail do organizador
firestore.rules     regras de segurança do banco
banner.jpg          banner da rifa
```

## 1. Configurar o Firebase

1. Crie um projeto em <https://console.firebase.google.com>. O Google Analytics é opcional e pode ser desligado.
2. **Firestore Database:** crie o banco em modo de produção. Uma região no Brasil, como `southamerica-east1`, deixa tudo mais rápido.
3. **Authentication:** clique em *Vamos começar* e ative o provedor **Google**.
4. **Configurações do projeto:** em *Seus apps*, adicione um app **Web** (ícone `</>`). Copie o objeto `firebaseConfig` e cole em `firebase-config.js`.
5. Em `firebase-config.js`, troque `SEU_EMAIL@gmail.com` pelo e-mail da sua conta Google.
6. **Regras:** abra *Firestore Database*, vá na aba *Regras*, cole o conteúdo de `firestore.rules`, troque `SEU_EMAIL@gmail.com` pelo mesmo e-mail e clique em **Publicar**.

## 2. Publicar no GitHub Pages

1. Crie um repositório e envie todos os arquivos desta pasta para a branch `main`.
2. No repositório, vá em **Settings → Pages**. Em *Source*, escolha **Deploy from a branch**, depois a branch `main` e a pasta `/ (root)`, e salve.
3. Em 1 ou 2 minutos o site fica disponível em `https://SEU_USUARIO.github.io/NOME_DO_REPO/`.
4. Volte ao Firebase, em **Authentication → Configurações → Domínios autorizados**, e adicione `SEU_USUARIO.github.io`. Sem isso, o login do organizador não funciona no site publicado.

## 3. Primeiro acesso

1. Abra o site e toque em **Área do organizador**, no rodapé.
2. Entre com a sua conta Google. No primeiro login, o site grava sozinho as configurações padrão no banco. Até isso acontecer, os participantes não conseguem reservar.
3. Em **Configurações**, confira a chave Pix, o WhatsApp, o nome de quem recebe o Pix e a data do sorteio, e salve.
4. Faça uma reserva de teste numa aba anônima e depois libere o número no painel.

## Testar no computador

Os módulos do Firebase não carregam abrindo o `index.html` direto do disco (`file://`). Use um servidor local:

```bash
npx serve .
# ou
python -m http.server 8000
```

Depois adicione `localhost` nos domínios autorizados do Firebase, se ainda não estiver lá.

## Segurança

- As chaves em `firebase-config.js` são públicas por natureza. Quem protege os dados são as regras do Firestore.
- Pelas regras, qualquer visitante pode **ler** a rifa e **criar reservas** em números livres, sempre com a situação "reservado" e com o valor Pix acima do mínimo.
- **Confirmar, editar, liberar, mudar configurações e registrar o sorteio** é permitido só para o e-mail do organizador.
- O site limita cada pedido a 20 números. Se alguém reservar sem pagar, libere os números pelo painel.
- Os nomes dos participantes ficam visíveis publicamente, porque a grade mostra o primeiro nome. Não guarde telefones nem outros dados pessoais nas observações.

## Limites do plano gratuito

O plano gratuito do Firestore tem uma cota diária de leituras. Cada visita lê os números já reservados, até 200 leituras. Para um chá de bebê isso costuma sobrar, mas vale acompanhar em **Firestore → Uso** nos dias de maior divulgação.
