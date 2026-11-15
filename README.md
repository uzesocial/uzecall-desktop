# UzeCall para Windows

App de Windows do [UzeCall](https://uzecall.vercel.app): abre o UzeCall numa janela própria e acrescenta o que o navegador não faz.

- Apertar para falar funcionando com o jogo na frente
- Escolher a tela ou a janela do jogo para transmitir, com o som do PC se quiser
- Fica perto do relógio: fechar a janela não derruba a call
- Abre junto com o Windows (opcional, pelo ícone perto do relógio)
- Atualiza sozinho

**Baixar:** [UzeCall-Setup.exe](https://github.com/uzesocial/uzecall-desktop/releases/latest/download/UzeCall-Setup.exe)

## Como lançar uma versão nova

1. Aumente o `version` no `package.json` (ex.: `1.0.0` → `1.0.1`).
2. Salve no GitHub. O GitHub Actions monta o instalador e publica em **Releases**.
3. Quem já tem o app instalado recebe a atualização sozinho.

## Rodar no próprio PC (para desenvolver)

```
npm install
npm start
```

Para testar com o site rodando no PC: `UZECALL_URL=http://localhost:3000 npm start`.
