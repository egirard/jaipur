import { expect, test } from '@playwright/test';
import { TestStepHelper } from '../helpers/test-step-helper';

async function armFlightCapture(page: import('@playwright/test').Page, selector: string) {
  await page.evaluate((flightSelector) => {
    const browserWindow = window as typeof window & { __jaipurFlightReady?: Promise<void> };
    browserWindow.__jaipurFlightReady = new Promise((resolve) => {
      const inspect = () => {
        const flight = document.querySelector<HTMLElement>(flightSelector);
        if (!flight) return;
        for (const animation of flight.getAnimations({ subtree: true })) animation.pause();
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.body, { childList: true, subtree: true });
      inspect();
    });
  }, selector);
}

async function waitForFlightCapture(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const browserWindow = window as typeof window & { __jaipurFlightReady?: Promise<void> };
    await browserWindow.__jaipurFlightReady;
  });
}

test('a fresh tabletop seats two QR-joined players around one touch market', async (
  { browser, page },
  testInfo
) => {
  test.skip(testInfo.project.name !== 'desktop', 'Tabletop visual coverage uses a landscape-sized display.');
  const steps = new TestStepHelper(page, testInfo);
  steps.setMetadata(
    'Shared tabletop mode',
    'A neutral tabletop keeps public play on the shared screen while each QR-joined phone shows only its trader’s private hand and return selections.'
  );
  await page.goto('/tt?seed=tabletop-e2e');

  const tableCode = page.locator('.shared-market > header strong');
  await expect(tableCode).toHaveText(/^[A-Z]{5}$/);
  const firstCode = await tableCode.textContent();
  const playerOneJoin = page.getByRole('link', {
    name: new RegExp(`Join tabletop ${firstCode} as Player 1`)
  });
  const playerTwoJoin = page.getByRole('link', {
    name: new RegExp(`Join tabletop ${firstCode} as Player 2`)
  });
  await expect(playerOneJoin.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(playerTwoJoin.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  const playerOneUrl = await playerOneJoin.getAttribute('href');
  const playerTwoUrl = await playerTwoJoin.getAttribute('href');
  expect(playerOneUrl).toContain('/hand/');
  expect(playerTwoUrl).toContain('/hand/');
  expect(playerOneUrl).toContain(`gameId=${firstCode}&seat=1`);
  expect(playerTwoUrl).toContain(`gameId=${firstCode}&seat=2`);

  const freshPage = await page.context().newPage();
  await freshPage.goto('/tt?seed=tabletop-e2e-second');
  await expect(freshPage.locator('.shared-market > header strong')).toHaveText(/^[A-Z]{5}$/);
  expect(await freshPage.locator('.shared-market > header strong').textContent()).not.toBe(firstCode);
  await freshPage.close();

  // Keep visual baselines stable after separately proving that every load gets a fresh code.
  await tableCode.evaluate((element) => element.textContent = 'TABLE');

  const firstContext = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const firstPhone = await firstContext.newPage();
  await firstPhone.goto(playerOneUrl ?? '');
  await firstPhone.getByLabel('Your trader name').fill('Asha');
  await firstPhone.getByRole('button', { name: 'Take this seat' }).click();

  const secondContext = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const secondPhone = await secondContext.newPage();
  await secondPhone.goto(playerTwoUrl ?? '');
  await secondPhone.getByLabel('Your trader name').fill('Belen');
  await secondPhone.getByRole('button', { name: 'Take this seat' }).click();

  await expect(page.locator('.market-card')).toHaveCount(5, { timeout: 5000 });
  await expect(page.locator('[data-seat="1"] h2')).toHaveText('Asha');
  await expect(page.locator('[data-seat="2"] h2')).toHaveText('Belen');
  await expect(firstPhone.locator('[data-e2e-hand-controller]')).toBeVisible();
  await expect(firstPhone.locator('.private-cards')).toBeVisible();
  await expect(firstPhone.locator('.shared-market, .token-rail')).toHaveCount(0);
  const privateGoodsCount = await firstPhone.locator('.card-grid button').count() +
    await secondPhone.locator('.card-grid button').count();
  await expect(page.locator('.tabletop-hand > img')).toHaveCount(privateGoodsCount);
  await expect(page.locator('.tabletop-hand :is(.piece-image, [alt="Diamond"], [alt="Gold"])')).toHaveCount(0);
  await expect.poll(() => firstPhone.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight
  }))).toEqual({ width: 393, height: 852, viewportWidth: 393, viewportHeight: 852 });

  const topTransform = await page.locator('.inverted-content').evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(topTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
  await expect(page.locator('.top-log .corner-log')).toHaveClass(/inverted/);
  await expect(page.locator('.bottom-log .corner-log')).not.toHaveClass(/inverted/);
  await expect(page.locator('[data-token-view-seat]')).toHaveCount(2);
  await expect(page.locator('[data-token-view-seat="1"] .rail-token')).toHaveCount(6);
  await expect(page.locator('[data-token-view-seat="2"] .rail-token')).toHaveCount(6);
  const topTokenCounts = await page.locator('[data-token-view-seat="1"] .rail-token > :last-child strong').allTextContents();
  const bottomTokenCounts = await page.locator('[data-token-view-seat="2"] .rail-token > :last-child strong').allTextContents();
  expect(topTokenCounts).toEqual(bottomTokenCounts);
  const topTokenTransform = await page.locator('[data-token-view-seat="1"] > div').evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(topTokenTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
  const topSupplyBox = await page.locator('[data-token-view-seat="1"]').boundingBox();
  const bottomSupplyBox = await page.locator('[data-token-view-seat="2"]').boundingBox();
  const sharedMarketBox = await page.locator('.shared-market').boundingBox();
  expect(topSupplyBox).not.toBeNull();
  expect(bottomSupplyBox).not.toBeNull();
  expect(sharedMarketBox).not.toBeNull();
  expect(topSupplyBox!.x + topSupplyBox!.width).toBeLessThan(sharedMarketBox!.x);
  expect(bottomSupplyBox!.x).toBeGreaterThan(sharedMarketBox!.x + sharedMarketBox!.width);
  const enabledRailToken = page.locator('[data-token-view-seat="1"] .rail-token:not(:disabled)').first();
  const enabledKind = await enabledRailToken.getAttribute('data-token-kind');
  const oppositeEnabledRailToken = page.locator(
    `[data-token-view-seat="2"] [data-token-kind="${enabledKind}"]`
  );
  const disabledRailToken = page.locator('[data-token-view-seat="1"] .rail-token:disabled').first();
  await expect(enabledRailToken).toHaveCSS('opacity', '1');
  await expect(oppositeEnabledRailToken).toBeEnabled();
  await expect(disabledRailToken).toHaveCSS('opacity', '1');
  const leatherStack = page.locator('[data-token-view-seat="1"] [data-token-kind="leather"] [data-token-stack]');
  await expect(leatherStack).toHaveAttribute('data-stack-direction', 'horizontal');
  await expect(leatherStack.locator('.supply-token')).toHaveCount(9);
  const firstRailRim = await leatherStack.locator('.token-chip-rim').nth(0).boundingBox();
  const secondRailRim = await leatherStack.locator('.token-chip-rim').nth(1).boundingBox();
  const desktopTokenChipBox = await leatherStack.locator('.stacked-token').first().boundingBox();
  expect(firstRailRim).not.toBeNull();
  expect(secondRailRim).not.toBeNull();
  expect(desktopTokenChipBox).not.toBeNull();
  expect(Math.abs(secondRailRim!.x - firstRailRim!.x)).toBeGreaterThanOrEqual(firstRailRim!.width - 1);
  expect(Math.abs(secondRailRim!.y - firstRailRim!.y)).toBeLessThanOrEqual(1);
  const deckBox = await page.locator('.deck-card').boundingBox();
  const marketCardBox = await page.locator('.market-card').first().boundingBox();
  expect(deckBox).not.toBeNull();
  expect(marketCardBox).not.toBeNull();
  expect(Math.abs(deckBox!.width - marketCardBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(deckBox!.height - marketCardBox!.height)).toBeLessThanOrEqual(1);
  expect(deckBox!.x + deckBox!.width).toBeLessThan(marketCardBox!.x);
  expect(Math.abs(
    deckBox!.y + deckBox!.height / 2 - (marketCardBox!.y + marketCardBox!.height / 2)
  )).toBeLessThanOrEqual(1);
  await expect(page.locator('.deck-count')).toHaveCount(2);
  const deckCountLabels = await page.locator('.deck-count').allTextContents();
  expect(deckCountLabels[0]).toBe(deckCountLabels[1]);
  expect(deckCountLabels[0]).toMatch(/^Deck\d+$/);
  const invertedDeckCount = await page.locator('.deck-count-top').evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(invertedDeckCount).toMatch(/^matrix\(-1, 0, 0, -1,/);
  await expect(page.locator('[data-stable-market-layout]')).toHaveCount(1);
  await expect(page.locator('.table-market-slot')).toHaveCount(5);
  await expect(page.locator('.table-market-slot > .table-exchange-target')).toHaveCount(5);
  await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-facing-enabled', 'true');
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '1');
  const initialMarketTransform = await page.locator('.market-card').first().evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(initialMarketTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
  const initialTargetTransform = await page
    .locator('.table-exchange-target:not(.target-placeholder)')
    .first()
    .evaluate((element) => getComputedStyle(element).transform);
  expect(initialTargetTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
  const initialHeaderTransform = await page.locator('.shared-market > header').evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(initialHeaderTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
  await expect(page.locator('.table-status')).toHaveCSS('transform', /matrix\(-1, 0, 0, -1,/);
  await expect(page.locator('.table-exchange-target').first()).toHaveAttribute('data-return-seat', '1');
  const initialSlotBoxes = await page.locator('.table-market-slot').evaluateAll((slots) =>
    slots.map((slot) => {
      const card = slot.querySelector<HTMLElement>('.market-card')!.getBoundingClientRect();
      const target = slot.querySelector<HTMLElement>('.table-exchange-target')!.getBoundingClientRect();
      return { card: { x: card.x, y: card.y }, target: { x: target.x, y: target.y } };
    })
  );
  for (const { card, target } of initialSlotBoxes) expect(target.y).toBeLessThan(card.y);
  const marketBeforeExchange = await page.locator('.table-market-slot .market-card').evaluateAll(
    (cards) => cards.map((card) => card.getAttribute('data-market-card-id'))
  );

  const topPlayerDraw = page.locator('.market-card:not(.camel):not(:disabled)').first();
  await topPlayerDraw.click();
  const topPrompt = page.locator('[data-prompt-seat="1"]');
  await expect(topPrompt).toBeVisible();
  const topPromptBox = await topPrompt.boundingBox();
  expect(topPromptBox).not.toBeNull();
  expect(topPromptBox!.y - sharedMarketBox!.y).toBeLessThan(24);
  const topPromptTransform = await topPrompt.evaluate(
    (element) => getComputedStyle(element).transform
  );
  expect(topPromptTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
  expect(topPromptBox!.y + topPromptBox!.height).toBeLessThan(initialSlotBoxes[0].target.y);
  await page.locator('[data-abandon-draw]').click();
  await expect(page.locator('[data-pending-draw]')).toHaveCount(0);

  const privateCards = firstPhone.locator('.card-grid [data-private-card-id]:not(.loaded)');
  const firstReturnId = await privateCards.nth(0).getAttribute('data-private-card-id');
  const secondReturnId = await privateCards.nth(1).getAttribute('data-private-card-id');
  await privateCards.nth(0).click();
  await expect(firstPhone.locator(`[data-private-card-id="${firstReturnId}"]`)).toHaveAttribute('aria-pressed', 'true');
  await firstPhone.locator(`[data-private-card-id="${secondReturnId}"]`).click();
  await expect(firstPhone.locator('.selection-summary strong')).toHaveText('2 selected for the table');

  const targets = page.locator('.table-exchange-target:not(:disabled)');
  const firstTargetMarketId = await targets.nth(0).getAttribute('data-table-exchange-target');
  await armFlightCapture(page, '.table-card-flight');
  await targets.nth(0).click();
  await waitForFlightCapture(page);
  await expect(page.locator('.table-card-flight').first()).toBeVisible();
  await expect(page.locator('.table-exchange-target.loaded')).toHaveCount(1);
  await expect(firstPhone.locator('.selection-summary strong')).toHaveText('1 selected for the table');
  await page.locator('.table-exchange-target:not(.loaded):not(:disabled)').first().click();
  const secondTargetMarketId = await page
    .locator('.table-exchange-target.loaded')
    .nth(1)
    .getAttribute('data-table-exchange-target');
  await expect(page.locator('.table-exchange-target.loaded')).toHaveCount(2);
  await expect(firstPhone.locator('.selection-summary strong')).toHaveText('0 selected for the table');
  await expect(firstPhone.locator('.card-grid button.loaded')).toHaveCount(2);

  await expect(page.locator('.table-card-flight, .table-token-flight')).toHaveCount(0, { timeout: 3000 });
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __jaipurTurnBarrier?: { pauseAt?: number; facingAt?: number };
    };
    const market = document.querySelector<HTMLElement>('.shared-market')!;
    browserWindow.__jaipurTurnBarrier = {};
    const inspect = () => {
      const barrier = browserWindow.__jaipurTurnBarrier!;
      if (market.dataset.turnPhase === 'pause' && barrier.pauseAt === undefined) {
        barrier.pauseAt = performance.now();
      }
      if (market.dataset.marketFacingSeat === '2' && barrier.pauseAt !== undefined && barrier.facingAt === undefined) {
        barrier.facingAt = performance.now();
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(market, { attributes: true });
    inspect();
  });
  await armFlightCapture(page, '.table-card-flight');
  await page.locator('[data-confirm-exchange]').click();
  await waitForFlightCapture(page);
  await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-phase', 'action');
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '1');
  await expect(page.locator('[data-seat="1"] .turn-state')).toHaveText('Your turn');
  await expect(page.locator('.shared-notice')).toHaveCount(0);
  await page.locator('.bottom-log summary').click();
  await expect(page.locator('.bottom-log li').first()).toContainText(/^Asha traded /);
  await page.locator('.bottom-log summary').click();
  await expect(page.locator('.table-card-flight, .table-token-flight')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '2');
  const turnBarrierDuration = await page.evaluate(() => {
    const barrier = (window as typeof window & {
      __jaipurTurnBarrier?: { pauseAt?: number; facingAt?: number };
    }).__jaipurTurnBarrier;
    return (barrier?.facingAt ?? 0) - (barrier?.pauseAt ?? 0);
  });
  expect(turnBarrierDuration).toBeGreaterThanOrEqual(190);
  await expect(page.locator('[data-seat="2"] .turn-state')).toHaveText('Your turn');
  const marketAfterExchange = await page.locator('.table-market-slot .market-card').evaluateAll(
    (cards) => cards.map((card) => card.getAttribute('data-market-card-id'))
  );
  const expectedMarketAfterExchange = [...marketBeforeExchange];
  expectedMarketAfterExchange[marketBeforeExchange.indexOf(firstTargetMarketId)] = firstReturnId;
  expectedMarketAfterExchange[marketBeforeExchange.indexOf(secondTargetMarketId)] = secondReturnId;
  expect(marketAfterExchange).toEqual(expectedMarketAfterExchange);
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '2');
  await expect(page.locator('.table-exchange-target').first()).toHaveAttribute('data-return-seat', '2');
  await expect.poll(() => page
    .locator('.table-exchange-target:not(.target-placeholder)')
    .first()
    .evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return [matrix.a, matrix.b, matrix.c, matrix.d].map((value) => Math.round(value));
    })
  ).toEqual([1, 0, 0, 1]);
  const slotBoxesAfterExchange = await page.locator('.table-market-slot').evaluateAll((slots) =>
    slots.map((slot) => {
      const card = slot.querySelector<HTMLElement>('.market-card')!.getBoundingClientRect();
      const target = slot.querySelector<HTMLElement>('.table-exchange-target')!.getBoundingClientRect();
      return { card: { x: card.x, y: card.y }, target: { x: target.x, y: target.y } };
    })
  );
  expect(slotBoxesAfterExchange.map(({ card }) => card)).toEqual(initialSlotBoxes.map(({ card }) => card));
  for (const [index, { card, target }] of slotBoxesAfterExchange.entries()) {
    expect(target.x).toBe(initialSlotBoxes[index].target.x);
    expect(target.y).toBeGreaterThan(card.y);
    expect(target.y).not.toBe(initialSlotBoxes[index].target.y);
  }

  const publicTake = page.locator('.market-card:not(.camel):not(:disabled)').first();
  await publicTake.click();
  await expect(page.locator('[data-pending-draw="one"]')).toBeVisible();
  await expect(page.locator('[data-pending-draw-card]')).toHaveCount(1);
  await expect(page.locator('[data-pending-draw-card] .piece-label')).toHaveText('Draw Single');
  await expect(firstPhone.locator('[data-pending-draw="one"]')).toContainText(
    'Draw awaiting confirmation on the table'
  );
  await expect(page.locator('.table-card-flight')).toHaveCount(0);
  const bottomPrompt = page.locator('[data-prompt-seat="2"]');
  const bottomPromptBox = await bottomPrompt.boundingBox();
  expect(bottomPromptBox).not.toBeNull();
  expect(sharedMarketBox!.y + sharedMarketBox!.height - bottomPromptBox!.y - bottomPromptBox!.height)
    .toBeLessThan(24);
  expect(Math.abs(
    topPromptBox!.x + topPromptBox!.width / 2 - (bottomPromptBox!.x + bottomPromptBox!.width / 2)
  )).toBeLessThanOrEqual(1);
  expect(Math.abs(
    topPromptBox!.y - sharedMarketBox!.y -
    (sharedMarketBox!.y + sharedMarketBox!.height - bottomPromptBox!.y - bottomPromptBox!.height)
  )).toBeLessThanOrEqual(1);
  const bottomReturnBox = await page.locator('.table-exchange-target').first().boundingBox();
  expect(bottomReturnBox).not.toBeNull();
  expect(bottomPromptBox!.y).toBeGreaterThan(bottomReturnBox!.y + bottomReturnBox!.height);
  await expect(bottomPrompt).toHaveCSS('transform', /matrix\(1, 0, 0, 1,/);
  await steps.step('pending-draw', {
    description: 'A pending draw keeps every market and token position stable',
    verifications: [
      {
        spec: 'The selected market slot remains face down until the active trader confirms or undoes the draw',
        check: async () => {
          await expect(page.locator('[data-pending-draw="one"]')).toBeVisible();
          await expect(page.locator('[data-pending-draw-card]')).toHaveCount(1);
        }
      },
      {
        spec: 'The confirmation prompt appears upright beside the receiving player’s edge',
        check: async () => {
          await expect(bottomPrompt).toHaveAttribute('data-prompt-seat', '2');
          expect(sharedMarketBox!.y + sharedMarketBox!.height - bottomPromptBox!.y - bottomPromptBox!.height)
            .toBeLessThan(24);
        }
      },
      {
        spec: 'Both seat-oriented token views show the same shared inventory',
        check: async () => {
          expect(
            await page.locator('[data-token-view-seat="1"] .rail-token > :last-child strong').allTextContents()
          ).toEqual(
            await page.locator('[data-token-view-seat="2"] .rail-token > :last-child strong').allTextContents()
          );
        }
      }
    ]
  });
  await page.locator('[data-abandon-draw]').click();
  await expect(page.locator('[data-pending-draw]')).toHaveCount(0);
  await expect(firstPhone.locator('[data-pending-draw]')).toHaveCount(0);
  await expect(page.locator('.table-card-flight')).toHaveCount(0);

  await publicTake.click();
  await expect(page.locator('[data-pending-draw="one"]')).toBeVisible();
  await armFlightCapture(page, '.table-card-flight.flips');
  await page.locator('[data-confirm-draw]').click();
  await waitForFlightCapture(page);
  const refillFlight = page.locator('.table-card-flight.flips');
  await expect(refillFlight).toHaveCount(1);
  await expect(refillFlight).toBeVisible();
  await expect(refillFlight.locator('.table-card-flight-front')).toHaveCount(1);
  const refillFlightSizes = await refillFlight.evaluate((flight) => {
    const style = getComputedStyle(flight);
    return {
      start: parseFloat(style.getPropertyValue('--start-size')),
      end: parseFloat(style.getPropertyValue('--end-size'))
    };
  });
  expect(Math.abs(refillFlightSizes.start - refillFlightSizes.end)).toBeLessThanOrEqual(1);
  const arrivingTableCard = page.locator('.market-card[data-card-arriving="true"]');
  await expect(arrivingTableCard).toHaveCount(1);
  await expect(arrivingTableCard).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-phase', 'action');
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '2');
  await expect(page.locator('[data-seat="2"] .turn-state')).toHaveText('Your turn');
  await expect(page.locator('.table-card-flight, .table-token-flight')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.market-card[data-card-arriving="true"]')).toHaveCount(0);
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '1');
  await expect(page.locator('[data-seat="1"] .turn-state')).toHaveText('Your turn');
  await expect.poll(() => page
    .locator('.table-exchange-target:not(.target-placeholder)')
    .first()
    .evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return [matrix.a, matrix.b, matrix.c, matrix.d].map((value) => Math.round(value));
    })
  ).toEqual([-1, 0, 0, -1]);

  const saleCard = firstPhone.getByRole('button', {
    name: /^Select (Cloth|Spice|Leather) /
  }).first();
  await expect(saleCard).toBeVisible();
  const saleKind = (await saleCard.getAttribute('aria-label'))
    ?.match(/^Select (Cloth|Spice|Leather) /)?.[1]
    ?.toLowerCase();
  expect(saleKind).toBeTruthy();
  await saleCard.click();
  await expect(firstPhone.locator('.selection-summary strong')).toHaveText('1 selected for the table');
  // Selling takes two taps: the first stages the sale (✓ on the stack and a
  // Sell/Cancel prompt), the second on the same stack confirms it.
  const saleStack = page.locator(`[data-token-view-seat="2"] [data-token-kind="${saleKind}"]`);
  await saleStack.click();
  await expect(saleStack).toHaveAttribute('data-sale-pending', 'true');
  await expect(page.locator('.market-prompt')).toHaveAttribute('data-pending-sale', saleKind!);
  await armFlightCapture(page, '.table-token-flight');
  await saleStack.click();
  await waitForFlightCapture(page);
  const saleTokenFlight = page.locator('.table-token-flight').first();
  await expect(saleTokenFlight).toBeVisible();
  await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-phase', 'action');
  await expect(page.locator('[data-seat="1"] .turn-state')).toHaveText('Your turn');
  const tokenFlightStart = await saleTokenFlight.evaluate((flight) =>
    parseFloat(getComputedStyle(flight).getPropertyValue('--start-left'))
  );
  expect(tokenFlightStart).toBeGreaterThan(sharedMarketBox!.x + sharedMarketBox!.width);
  await expect(page.locator('[data-seat="1"] .seat-tokens')).toHaveText('1 token');
  await expect(page.locator('[data-seat="1"] .seat-tokens .token-chip')).toHaveCount(0);
  await expect(page.locator('[data-seat="1"] .seat-tokens')).not.toContainText('points');
  await expect(firstPhone.locator('[data-private-token-tray]')).toContainText(/1 worth \d+ points/);
  await expect(firstPhone.locator('[data-private-token-tray] .token-chip')).toHaveCount(1);
  const privateTokenValue = await firstPhone
    .locator('[data-private-token-tray] .token-chip-rim')
    .textContent();
  await expect(firstPhone.locator('[data-private-token-tray]'))
    .toContainText(`1 worth ${privateTokenValue} points`);
  await expect.poll(() => firstPhone.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight
  }))).toEqual({ width: 393, height: 852, viewportWidth: 393, viewportHeight: 852 });
  await expect(page.locator('.table-card-flight, .table-token-flight')).toHaveCount(0, { timeout: 3000 });
  await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '2');
  await expect(page.locator('[data-seat="2"] .turn-state')).toHaveText('Your turn');

  const desktopCardSize = marketCardBox!.width;
  const desktopTokenSize = desktopTokenChipBox!.width;
  await page.setViewportSize({ width: 3840, height: 2160 });
  const fourKCardBox = await page.locator('.market-card').first().boundingBox();
  const fourKTokenBox = await leatherStack.locator('.stacked-token').first().boundingBox();
  expect(fourKCardBox).not.toBeNull();
  expect(fourKTokenBox).not.toBeNull();
  expect(fourKCardBox!.width).toBeGreaterThan(desktopCardSize * 2);
  expect(fourKTokenBox!.width).toBeGreaterThan(desktopTokenSize * 1.8);
  await expect.poll(() => page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight
  }))).toEqual({ width: 3840, height: 2160, viewportWidth: 3840, viewportHeight: 2160 });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(async () => (await page.locator('.market-card').first().boundingBox())?.width)
    .toBeCloseTo(desktopCardSize, 0);

  const facingToggle = page.getByRole('button', { name: 'Face market cards toward the active trader' });
  await expect(facingToggle).toHaveAttribute('aria-pressed', 'true');
  await facingToggle.click();
  await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-facing-enabled', 'false');
  await facingToggle.click();
  await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-facing-enabled', 'true');

  await steps.step('two-seated-table', {
    description: 'Two opposite player edges share one market and mirrored token supplies',
    verifications: [
      {
        spec: 'The top player UI and its upper-left log are rotated exactly 180 degrees',
        check: async () => {
          expect(topTransform).toMatch(/^matrix\(-1, 0, 0, -1,/);
          const topLog = await page.locator('.top-log').boundingBox();
          expect(topLog!.x).toBeGreaterThan(topSupplyBox!.x + topSupplyBox!.width);
          expect(topLog?.y).toBeLessThan(20);
        }
      },
      {
        spec: 'The lower player UI and lower-right log remain upright',
        check: async () => {
          const lowerLog = await page.locator('.bottom-log').boundingBox();
          expect(lowerLog!.x + lowerLog!.width).toBeLessThan(bottomSupplyBox!.x);
          expect(lowerLog?.y).toBeGreaterThan(900);
        }
      },
      {
        spec: 'The synchronized token views occupy opposite full-height rails and face their respective players',
        check: async () => {
          await expect(page.locator('[data-token-view-seat]')).toHaveCount(2);
          expect(topSupplyBox!.x + topSupplyBox!.width).toBeLessThan(sharedMarketBox!.x);
          expect(bottomSupplyBox!.x).toBeGreaterThan(sharedMarketBox!.x + sharedMarketBox!.width);
          expect(
            await page.locator('[data-token-view-seat="1"] .rail-token > :last-child strong').allTextContents()
          ).toEqual(
            await page.locator('[data-token-view-seat="2"] .rail-token > :last-child strong').allTextContents()
          );
        }
      },
      {
        spec: 'Either token view can complete the active player’s sale',
        check: async () => {
          expect(tokenFlightStart).toBeGreaterThan(sharedMarketBox!.x + sharedMarketBox!.width);
          await expect(firstPhone.locator('[data-private-token-tray] .token-chip')).toHaveCount(1);
        }
      },
      {
        spec: 'Cards and supply tokens scale up substantially when a 4K tabletop is available',
        check: async () => {
          expect(fourKCardBox!.width).toBeGreaterThan(desktopCardSize * 2);
          expect(fourKTokenBox!.width).toBeGreaterThan(desktopTokenSize * 1.8);
        }
      },
      {
        spec: 'Action animation settles before the 200 ms turn handoff and market rotation',
        check: async () => {
          expect(turnBarrierDuration).toBeGreaterThanOrEqual(190);
          await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-phase', 'ready');
        }
      },
      {
        spec: 'Market cards face the active player and return areas move to the player-near side',
        check: async () => {
          await expect(page.locator('.shared-market')).toHaveAttribute('data-turn-facing-enabled', 'true');
          await expect(page.locator('.shared-market')).toHaveAttribute('data-market-facing-seat', '2');
          const currentHeaderTransform = await page.locator('.shared-market > header').evaluate(
            (element) => getComputedStyle(element).transform
          );
          expect(currentHeaderTransform).toMatch(/^matrix\(1, 0, 0, 1,/);
          await expect(page.locator('.table-status')).toHaveCSS('transform', 'none');
          await expect.poll(() => page
            .locator('.table-exchange-target:not(.target-placeholder)')
            .first()
            .evaluate((element) => {
              const matrix = new DOMMatrix(getComputedStyle(element).transform);
              return [matrix.a, matrix.b, matrix.c, matrix.d].map((value) => Math.round(value));
            })
          ).toEqual([1, 0, 0, 1]);
          const finalBoxes = await page.locator('.table-market-slot').evaluateAll((slots) =>
            slots.map((slot) => {
              const card = slot.querySelector<HTMLElement>('.market-card')!.getBoundingClientRect();
              const target = slot.querySelector<HTMLElement>('.table-exchange-target')!.getBoundingClientRect();
              return { card: { x: card.x, y: card.y }, target: { x: target.x, y: target.y } };
            })
          );
          expect(finalBoxes.map(({ card }) => card)).toEqual(initialSlotBoxes.map(({ card }) => card));
          for (const { card, target } of finalBoxes) expect(target.y).toBeGreaterThan(card.y);
        }
      },
      {
        spec: 'The draw pile sits left of the market row with a count readable from each seat',
        check: async () => {
          await expect(page.locator('.deck-count')).toHaveCount(2);
          expect(invertedDeckCount).toMatch(/^matrix\(-1, 0, 0, -1,/);
          expect(deckBox!.x + deckBox!.width).toBeLessThan(marketCardBox!.x);
        }
      },
      {
        spec: 'All five market cards keep permanent coordinates while return areas switch reserved sides',
        check: async () => {
          const finalBoxes = await page.locator('.table-market-slot').evaluateAll((slots) =>
            slots.map((slot) => {
              const card = slot.querySelector<HTMLElement>('.market-card')!.getBoundingClientRect();
              const target = slot.querySelector<HTMLElement>('.table-exchange-target')!.getBoundingClientRect();
              return { card: { x: card.x, y: card.y }, target: { x: target.x, y: target.y } };
            })
          );
          expect(finalBoxes.map(({ card }) => card)).toEqual(initialSlotBoxes.map(({ card }) => card));
          for (const { card, target } of finalBoxes) expect(target.y).toBeGreaterThan(card.y);
        }
      },
      {
        spec: 'Private phone selections load face-down table targets and keep exact token values private',
        check: async () => {
          await expect(page.locator('[data-seat="2"] .turn-state')).toHaveText('Your turn');
          await expect(page.locator('.market-card')).toHaveCount(5);
          await expect(page.locator('.tabletop-hand > img')).toHaveCount(privateGoodsCount);
          await expect(page.locator('[data-seat="1"] .seat-tokens')).toHaveText('1 token');
          await expect(page.locator('[data-seat="1"] .seat-tokens')).not.toContainText('points');
          await expect(firstPhone.locator('[data-private-token-tray]')).toContainText(/1 worth \d+ points/);
        }
      },
      {
        spec: 'Public actions use direct card flights instead of a text notification overlay',
        check: async () => {
          await expect(page.locator('.shared-notice, [data-notice-key]')).toHaveCount(0);
        }
      },
      {
        spec: 'The complete tabletop fits without document scrolling',
        check: async () => {
          await expect.poll(() => page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            x: scrollX,
            y: scrollY
          }))).toEqual({
            width: 1280,
            height: 1000,
            viewportWidth: 1280,
            viewportHeight: 1000,
            x: 0,
            y: 0
          });
        }
      }
    ]
  });

  steps.generateDocs();
  await firstContext.close();
  await secondContext.close();
});
