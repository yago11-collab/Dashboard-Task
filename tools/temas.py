# Paletas de los temas de la app y comprobación de contraste (WCAG AA).
#   python3 tools/temas.py            -> comprueba el contraste de todos los temas
#   python3 tools/temas.py css x.css  -> genera el bloque de variables para pegar en app.css

import sys

# Paletas: cada tema tiene modo claro y oscuro. Las claves se convierten en variables CSS.
THEMES = {
 'clasico': {
  'light': dict(bg='#faf9f5', card='#ffffff', hover='#efeee8', col='#f3f2ec',
    text='#141413', text2='#5c5c5a', text3='#6e6d69',
    accent='#d5714f', fill='#b95c3c', onfill='#ffffff', asoft='#fbeee8', atext='#a54e31',
    border='#e5e4df', border2='#d2d1ca',
    danger='#c43d3d', dsoft='#fdecec', ok='#2f7a4a', oksoft='#e8f4ec', info='#2566a0', isoft='#e6f1fa', wsoft='#fbf1d9', wtext='#7d5108',
    side='#f3f2ec', sidetext='#5c5c5a', sidestrong='#141413', sidehover='#e9e8e1', sideon='#ffffff', sideontext='#141413', sidemuted='#6e6d69', sideborder='#e5e4df', snote='#fbf1d9', snotetext='#7d5108',
    shadow='74, 60, 40'),
  'dark': dict(bg='#1b1a18', card='#252422', hover='#2e2d2a', col='#201f1d',
    text='#f2f1ec', text2='#b5b4ae', text3='#95948e',
    accent='#e08a6c', fill='#e08a6c', onfill='#1b1a18', asoft='#3a2a23', atext='#f0a88e',
    border='#33322f', border2='#45443f',
    danger='#ef7070', dsoft='#3d2424', ok='#6fc08b', oksoft='#22352a', info='#74b3e8', isoft='#1f2f3d', wsoft='#3a3120', wtext='#e6bf6a',
    side='#161513', sidetext='#b5b4ae', sidestrong='#f2f1ec', sidehover='#23221f', sideon='#252422', sideontext='#f2f1ec', sidemuted='#95948e', sideborder='#2b2a27', snote='#3a3120', snotetext='#e6bf6a',
    shadow='0, 0, 0'),
 },
 'calma': {
  'light': dict(bg='#ffffff', card='#ffffff', hover='#f1f3f5', col='#f5f6f8',
    text='#1d1f23', text2='#4b5058', text3='#676d77',
    accent='#2f7cf6', fill='#1f6ae0', onfill='#ffffff', asoft='#e8f1fe', atext='#1a5fd0',
    border='#e8eaee', border2='#d3d7dd',
    danger='#c62a2f', dsoft='#fdebec', ok='#1d7a45', oksoft='#e6f5ec', info='#1a5fd0', isoft='#e8f1fe', wsoft='#fff4d4', wtext='#735200',
    side='#f5f6f8', sidetext='#4b5058', sidestrong='#1d1f23', sidehover='#eceef1', sideon='#e4e7ec', sideontext='#1d1f23', sidemuted='#676d77', sideborder='#e8eaee', snote='#fff4d4', snotetext='#735200',
    shadow='20, 30, 50'),
  'dark': dict(bg='#1c1d21', card='#26282d', hover='#2d3036', col='#212327',
    text='#eceef2', text2='#b4b9c2', text3='#9096a0',
    accent='#4a90ff', fill='#4a90ff', onfill='#0b1a33', asoft='#1f2d46', atext='#8cb8ff',
    border='#2f3238', border2='#3d4047',
    danger='#ff7b7f', dsoft='#3b2124', ok='#5fd08f', oksoft='#1c3527', info='#8cb8ff', isoft='#1f2d46', wsoft='#3a321c', wtext='#f0c75e',
    side='#18191c', sidetext='#b4b9c2', sidestrong='#eceef2', sidehover='#222429', sideon='#2d3036', sideontext='#ffffff', sidemuted='#9096a0', sideborder='#26282d', snote='#3a321c', snotetext='#f0c75e',
    shadow='0, 0, 0'),
 },
 'papel': {
  'light': dict(bg='#fbfaf7', card='#ffffff', hover='#f1eee8', col='#f3f1ec',
    text='#2b2a28', text2='#57544e', text3='#716d66',
    accent='#d9473f', fill='#c23a32', onfill='#ffffff', asoft='#fbe9e7', atext='#aa322b',
    border='#ebe8e1', border2='#d8d3c9',
    danger='#b8322b', dsoft='#fbe9e7', ok='#2f7a4a', oksoft='#e8f3eb', info='#3a6b8f', isoft='#e8f0f5', wsoft='#faf0d9', wtext='#7a5209',
    side='#2a2b2e', sidetext='#c2c1bd', sidestrong='#ffffff', sidehover='#333437', sideon='#3d3e42', sideontext='#ffffff', sidemuted='#9b9a96', sideborder='#38393c', snote='#3d3526', snotetext='#f0c979',
    shadow='60, 50, 35'),
  'dark': dict(bg='#1e1f21', card='#27282b', hover='#2f3033', col='#232427',
    text='#ecebe7', text2='#b8b6b0', text3='#96948e',
    accent='#ef6a62', fill='#ef6a62', onfill='#1e1f21', asoft='#3b2220', atext='#ff9d96',
    border='#313235', border2='#404145',
    danger='#ff8a83', dsoft='#3b2220', ok='#6fc08b', oksoft='#22352a', info='#8fbbd9', isoft='#1f2c36', wsoft='#3a3120', wtext='#e6bf6a',
    side='#151618', sidetext='#b8b6b0', sidestrong='#ffffff', sidehover='#1f2022', sideon='#2a2b2e', sideontext='#ffffff', sidemuted='#8f8d88', sideborder='#232427', snote='#3a3120', snotetext='#e6bf6a',
    shadow='0, 0, 0'),
 },
 'foco': {
  'light': dict(bg='#fcfcfd', card='#ffffff', hover='#eef0f3', col='#f3f4f6',
    text='#1b1c1f', text2='#4d5159', text3='#686c75',
    accent='#5e6ad2', fill='#5059c4', onfill='#ffffff', asoft='#eceefc', atext='#4149b0',
    border='#e6e7ea', border2='#d3d5da',
    danger='#c42f39', dsoft='#fcebec', ok='#1f7a48', oksoft='#e6f4ec', info='#4149b0', isoft='#eceefc', wsoft='#fbf2d8', wtext='#735200',
    side='#f3f4f6', sidetext='#4d5159', sidestrong='#1b1c1f', sidehover='#e9ebee', sideon='#e2e4e9', sideontext='#1b1c1f', sidemuted='#686c75', sideborder='#e6e7ea', snote='#fbf2d8', snotetext='#735200',
    shadow='15, 20, 35'),
  'dark': dict(bg='#101113', card='#16171a', hover='#1c1e22', col='#141518',
    text='#e6e7ea', text2='#a4a8b0', text3='#8a8e97',
    accent='#7c86e0', fill='#7c86e0', onfill='#0b0c0e', asoft='#1e2140', atext='#aab2f5',
    border='#1f2125', border2='#31343b',
    danger='#ff8a8f', dsoft='#3a1d20', ok='#6fd49a', oksoft='#15301f', info='#aab2f5', isoft='#1e2140', wsoft='#33291a', wtext='#f2c46b',
    side='#0b0c0e', sidetext='#a4a8b0', sidestrong='#e6e7ea', sidehover='#16181b', sideon='#1c1e22', sideontext='#ffffff', sidemuted='#80848d', sideborder='#1a1b1e', snote='#33291a', snotetext='#f2c46b',
    shadow='0, 0, 0'),
 },
}

def lum(hexc):
    h = hexc.lstrip('#'); r, g, b = (int(h[i:i+2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)

TEXT = 4.5; UI = 3.0
CHECKS = [
  ('text', 'bg', TEXT), ('text2', 'bg', TEXT), ('text2', 'card', TEXT), ('text2', 'col', TEXT), ('text2', 'hover', TEXT),
  ('text3', 'bg', TEXT), ('text3', 'card', TEXT), ('text3', 'col', TEXT),
  ('onfill', 'fill', TEXT), ('atext', 'asoft', TEXT), ('atext', 'card', TEXT), ('atext', 'bg', TEXT),
  ('danger', 'dsoft', TEXT), ('danger', 'card', TEXT), ('danger', 'bg', TEXT),
  ('ok', 'oksoft', TEXT), ('info', 'isoft', TEXT), ('info', 'bg', TEXT), ('wtext', 'wsoft', TEXT),
  ('sidetext', 'side', TEXT), ('sidemuted', 'side', TEXT), ('sideontext', 'sideon', TEXT), ('sidetext', 'sidehover', TEXT),
  ('snotetext', 'snote', TEXT),
  ('accent', 'bg', UI), ('accent', 'card', UI), ('border2', 'card', 1.4),
]

bad = 0
for theme, modes in THEMES.items():
    for mode, p in modes.items():
        for fg, bg, need in CHECKS:
            r = ratio(p[fg], p[bg])
            if r < need:
                bad += 1
                print(f'FALLA {theme}/{mode}: {fg} {p[fg]} sobre {bg} {p[bg]} = {r:.2f} (mín {need})')
print('fallos:', bad)

if len(sys.argv) > 1 and sys.argv[1] == 'css':
    NAMES = dict(bg='--bg', card='--bg-card', hover='--bg-hover', col='--col-bg', text='--text', text2='--text-2', text3='--text-3',
      accent='--accent', fill='--accent-fill', onfill='--on-accent', asoft='--accent-soft', atext='--accent-text',
      border='--border', border2='--border-2', danger='--danger', dsoft='--danger-soft', ok='--ok', oksoft='--ok-soft',
      info='--info', isoft='--info-soft', wsoft='--warn-soft', wtext='--warn-text',
      side='--side-bg', sidetext='--side-text', sidestrong='--side-strong', sidehover='--side-hover', sideon='--side-on',
      sideontext='--side-on-text', sidemuted='--side-muted', sideborder='--side-border', snote='--side-note', snotetext='--side-note-text')
    def block(sel, p, mode):
        lines = [f'{sel} {{']
        for k, v in p.items():
            if k == 'shadow': continue
            lines.append(f'  {NAMES[k]}: {v};')
        s = p['shadow']
        if mode == 'light':
            lines.append(f'  --shadow: 0 1px 2px rgba({s}, 0.06), 0 2px 6px rgba({s}, 0.04);')
            lines.append(f'  --shadow-hover: 0 2px 4px rgba({s}, 0.07), 0 6px 16px rgba({s}, 0.07);')
            lines.append(f'  --shadow-lg: 0 8px 20px rgba({s}, 0.10), 0 24px 60px rgba({s}, 0.16);')
        else:
            lines.append('  --shadow: none;')
            lines.append('  --shadow-hover: 0 0 0 1px var(--border-2);')
            lines.append('  --shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.5);')
        lines.append(f'  color-scheme: {mode};')
        lines.append('}')
        return '\n'.join(lines)
    out = ['/* ===== Temas (generados con contraste comprobado) ===== */']
    for theme, modes in THEMES.items():
        base = ':root' if theme == 'clasico' else f':root[data-theme="{theme}"]'
        out.append(f'/* {theme} */')
        out.append(block(f'{base}' if theme != 'clasico' else ':root', modes['light'], 'light'))
        dark_sel = ':root[data-mode="dark"]' if theme == 'clasico' else f':root[data-theme="{theme}"][data-mode="dark"]'
        out.append(block(dark_sel, modes['dark'], 'dark'))
    open(sys.argv[2], 'w').write('\n\n'.join(out) + '\n')
