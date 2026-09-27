# Live Translator

Extensão para Chrome que traduz conteúdo novo enquanto você navega. Foi criada para feeds com rolagem infinita, como X e Reddit, mas também procura texto em páginas comuns. O texto original permanece no DOM; a tradução aparece ao lado dele ou em seu lugar, conforme a preferência de exibição.

## Instalação

Requer **Chrome 138 ou mais recente**.

1. Baixe o código deste repositório e extraia o arquivo, ou clone o repositório.
2. Abra `chrome://extensions` e ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta que contém `manifest.json`.
4. Recarregue as abas que já estavam abertas.

Se uma versão anterior estiver instalada em outra pasta, desative-a antes para evitar duas traduções no mesmo post. Para atualizar uma instalação sem compactação, substitua os arquivos e clique em **Recarregar** na página de extensões.

## Uso

A tradução automática vem ativada. Abra o popup para escolher o motor (**Automático**, **Google** ou **Chrome local**), a exibição (**Só português** ou **Original + português**) e se a extensão deve agir em todos os sites ou apenas nas redes sociais reconhecidas.

Para deixar um site fora da tradução:

1. Abra o site e clique no ícone da extensão.
2. Clique em **Ignorar este site**.
3. Para desfazer, clique em **Voltar a traduzir este site** ou abra **Sites ignorados** e clique em **Reativar** ao lado do domínio.

A preferência é salva no Chrome e se aplica às abas abertas do mesmo host. `www.exemplo.com` e `exemplo.com` compartilham a regra; `blog.exemplo.com` é um host diferente. Ao ignorar, os blocos traduzidos são retirados da página. Ao reativar, a tradução volta automaticamente, sem recarregar a aba. O botão **Reprocessar página** fica disponível para uma varredura manual se necessário.

## Como funciona

- Um `MutationObserver` detecta texto inserido em páginas dinâmicas; um `IntersectionObserver` prioriza o que chega perto da tela. Uma varredura periódica recupera elementos perdidos durante atualizações rápidas do feed.
- X usa o texto dos posts identificado por `[data-testid="tweetText"]`. Reddit e páginas comuns usam seletores próprios. Nem todo layout ou texto embutido em imagens é coberto.
- A tradução é inserida em um bloco separado. Links encontrados no conteúdo original são recriados com seus destinos originais; se o texto do link mudar na tradução, ele fica ao final do bloco traduzido. O botão **Original** permite conferir o post como foi publicado.
- A extensão guarda traduções em memória durante a sessão e tenta novamente após falhas transitórias. Um post que sai da página antes de ser processado pode não receber tradução.

## Tradução e privacidade

No modo **Automático**, o Chrome Translator é usado quando o pacote do idioma já está instalado; caso contrário, a extensão recorre ao Google. O modo **Chrome local** não envia o texto ao Google, mas depende de um pacote local disponível. Campos de formulário, áreas editáveis, scripts e blocos de código não são traduzidos.

Os modos que usam Google enviam o texto do conteúdo ao serviço de tradução. A integração usa um endpoint web sem chave, que não é a API oficial Google Cloud Translation e pode mudar ou impor limites. Não há conta, servidor próprio, telemetria ou coleta de dados pela extensão. Uma requisição que já começou antes de você ignorar um site não pode ser retirada do serviço; nenhuma tradução recebida depois dessa mudança é exibida.

As permissões de leitura de páginas permitem encontrar conteúdo novo. A permissão de armazenamento salva suas preferências e os hosts ignorados. O acesso a `translate.googleapis.com` e `translate.google.com` é usado apenas nos modos que recorrem ao Google.

## Desenvolvimento

O projeto não usa etapa de build nem dependências de runtime. Para executar os testes locais:

```bash
node --test tests/*.test.cjs
```

## Licença

[MIT](LICENSE).
