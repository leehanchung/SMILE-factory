"""Small local report bridge, implementing observed full-document editor messages.

This is not the proprietary block editor. Stable static documents support native
text editing with full-content saves; script-built documents use the real worker
chat. Content remains in an opaque-origin sandbox.
"""

import re
from html.parser import HTMLParser


BRIDGE = r"""(() => {
  'use strict';
  const send = data => parent.postMessage(data, '*');
  let editing = false, baseline = '', history = [], index = 0, quote = false;
  const issues = [];
  const serialize = () => {
    const copy = document.documentElement.cloneNode(true);
    copy.querySelectorAll('[data-rea-bridge]').forEach(e => e.remove());
    copy.querySelectorAll('[data-rea-editable]').forEach(e => {
      e.removeAttribute('contenteditable'); e.removeAttribute('data-rea-editable');
    });
    return '<!doctype html>\n' + copy.outerHTML;
  };
  const state = () => send({type:'silico-editor-state',dirty:editing && serialize() !== baseline,
    canUndo:index > 0, canRedo:index < history.length - 1});
  const setEditable = value => {
    document.body.contentEditable = value ? 'true' : 'false';
    if(value) document.body.setAttribute('data-rea-editable','true');
    else {document.body.removeAttribute('contenteditable');document.body.removeAttribute('data-rea-editable');}
  };
  const restore = content => {
    const parsed = new DOMParser().parseFromString(content, 'text/html');
    document.body.innerHTML = parsed.body.innerHTML;
    setEditable(editing); state();
  };
  const size = () => send({type:'silico-app-height',height:document.documentElement.scrollHeight});
  window.addEventListener('error', event => issues.push({severity:'error',message:event.message || 'Report resource failed'}));
  document.addEventListener('input', () => {
    if (!editing) return;
    history = history.slice(0,index + 1); history.push(serialize()); index++;
    state(); size();
  });
  document.addEventListener('paste', event => {
    if(!editing) return;
    event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });
  document.addEventListener('mouseup', () => {
    if(!quote || editing) return;
    const text = String(window.getSelection()).trim();
    if(text) send({type:'page-leave-comment',text:text.slice(0,16000)});
  });
  const print = title => {
    if(title) document.title = String(title);
    window.print(); send({type:'silico-print-done'});
  };
  window.addEventListener('message', event => {
    if(event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const data = event.data;
    if(data.type === 'silico-app-health-check') {
      send({type:'silico-app-ready',nonce:data.nonce,ok:!!document.body && !issues.length,issues}); size();
    } else if(data.type === 'silico-quote-state') quote = data.mode === 'composer' && !data.editing;
    else if(data.type === 'silico-print') print(data.title);
    else if(data.type === 'silico-search-content-req') {
      send({type:'silico-search-content',nodes:[document.body.innerText],epoch:Date.now()});
    } else if(data.type === 'silico-editor-control') {
      if(data.action === 'enable') {
        if([...document.scripts].some(script => !script.hasAttribute('data-rea-bridge'))) {
          send({type:'silico-editor-state',error:'unstamped'}); return;
        }
        baseline = serialize(); history = [baseline]; index = 0;
        editing = true; setEditable(true); state();
      } else if(data.action === 'capture') {
        send(editing ? {type:'silico-editor-edits',content:serialize()} : {type:'silico-editor-edits',error:'not-editing'});
      } else if(data.action === 'revert') {
        if(editing) restore(baseline); editing = false; setEditable(false); state();
      } else if(data.action === 'disable') {editing = false; setEditable(false);state();}
      else if(data.action === 'undo' && index > 0) restore(history[--index]);
      else if(data.action === 'redo' && index < history.length-1) restore(history[++index]);
      else if(data.action === 'rebase') {baseline = serialize();history=[baseline];index=0;state();}
      else if(data.action === 'rehydrate') send({type:'silico-editor-rehydrated',ok:false});
    }
  });
  window.addEventListener('DOMContentLoaded', () => {
    size(); new ResizeObserver(size).observe(document.body);
    const params = new URLSearchParams(location.search);
    if(params.get('silico_print') === '1') setTimeout(() => print(params.get('silico_print_title')),100);
  });
})();"""


def inject_bridge(data):
    source = data.decode("utf-8", errors="replace")
    script = '<script data-rea-bridge="1">' + BRIDGE + '</script>'
    head = re.search(r"<head\b[^>]*>", source, re.I)
    if head:
        source = source[:head.end()] + script + source[head.end():]
    else:
        source = script + source
    return source.encode()


class MarkdownContent(HTMLParser):
    """Extract the text of our Markdown wrapper after native text editing."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.active = False
        self.found = False
        self.chunks = []

    def handle_starttag(self, tag, attrs):
        if tag == "pre" and dict(attrs).get("data-rea-markdown") == "true":
            if self.found:
                raise ValueError("Multiple report roots")
            self.active = self.found = True
        elif self.active and tag in {"br", "div", "p"}:
            self.chunks.append("\n")

    def handle_endtag(self, tag):
        if tag == "pre":
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.chunks.append(data)

    @classmethod
    def extract(cls, content):
        parser = cls()
        parser.feed(content)
        if not parser.found:
            raise ValueError("The Markdown report root was removed; use the agent for structural edits")
        return "".join(parser.chunks).encode()
