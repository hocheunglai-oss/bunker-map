# Mobile navigation placement

The shared FCUNO/SPC Tools button was fixed to the viewport. At a 320px phone
width, scrolling a form input to the top of the viewport put the Tools icon
above the input; a real DOM hit test returned the icon rather than the field.
The committed CSS at `ae758c5b780d7c65b9d683cb455e6e5d8a7b5d86` reproduced
this failure using `FCUNO_NAV_BASELINE=1` with the isolated regression below.

The button now occupies its own normal document row on widths up to 980px,
instead of floating over content. The redundant top spacer is removed. It
scrolls with the page; return to the top to open Tools, or use the existing `/`
keyboard shortcut when not typing. The drawer, backdrop, page permissions,
desktop navigation, collapsed state and print rules are unchanged.

`tests/mobile-navigation.browser.test.cjs` passed 24 combinations: actual admin
and SPC navigation shells/global CSS, Chromium and WebKit, 320/390/1440px,
light/dark system preferences. Each includes drawer open/close, scrolled input
hit testing and typing, keyboard open/search focus/Escape, desktop collapse and
expand, no horizontal page overflow and signed-out removal of navigation.
Auth and page content are synthetic; external requests are blocked. All owned
browser contexts and the local server close after the run. Screenshots were
inspected at narrow/representative phone and desktop sizes. The current admin
palette is fixed light; both OS preferences were tested without inventing a
night-theme switch. A physical iPhone was not tested.

Screenshot output: `/private/tmp/fcuno-mobile-navigation-20261015/`. Actual
Outlook/SPC page checks must also be rerun after combining this stylesheet with
the page repairs; the shell fixture is not live sign-in or propagation proof.
