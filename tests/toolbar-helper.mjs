// Select a tool through the same overflow menu a reader uses at narrower widths.
export async function selectTool(page, label) {
  const button = page.getByLabel(label, { exact: true });
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await page.locator('.tool-overflow').click();
  await page
    .getByRole('menu', { name: '更多工具' })
    .getByRole('menuitem', { name: new RegExp(`^${label}(?:\\s|$)`) })
    .click();
  // Sticky notes and text keep the menu open to support pinning by double-click.
  if (await page.getByRole('menu', { name: '更多工具' }).isVisible())
    await page.keyboard.press('Escape');
}
