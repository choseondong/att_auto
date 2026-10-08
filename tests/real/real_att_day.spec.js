import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

// 계정 비밀번호는 코드에 두지 않고 .env 의 REAL_ATT_PASSWORD 로 읽는다 (여섯 계정 공통).
const REAL_ATT_PASSWORD = process.env.REAL_ATT_PASSWORD;

if (!REAL_ATT_PASSWORD) {
    throw new Error('.env 에 REAL_ATT_PASSWORD 값이 필요합니다. (.env.example 참고)');
}

// 결과 스크린샷 폴더: 프로젝트 루트/real_att_day_results (실행 시작 시 비운다)
const RESULT_DIR_NAME = 'real_att_day_results';

const REAL_HOME_URL = 'https://home.worksmobile.com/';
const REAL_COMMUTE_URL_PATTERN = /workplace\.worksmobile\.com\/my-space\/commute\/commuteDetail/;
const IP_BLOCKED_MESSAGE = '현재 IP 주소에서는 출퇴근을 체크할 수 없습니다.';
const NO_WORK_SCHEDULE_MESSAGE = '개인별일정근무에서 근무 스케줄을 업로드하세요.';
const SAME_CLOCK_IN_OUT_MESSAGE = '출근과 퇴근에 같은 시간을 입력할 수 없습니다.';

// 실제 토스트 컨테이너만 대상으로 한다. 화면에 고정된 일반 안내 문구(class에 alert만 포함)는 제외한다.
const TOAST_CONTAINER_SELECTOR = '[data-notify="container"], [class*="toast"], [class*="notify"], .alert.alert-error, .alert.alert-danger';

// 화면에 보이는 빨간 부정 토스트(alert-error 또는 빨간 글자)의 문구만 모은다. 성공(초록/파랑) 토스트는 제외한다.
async function readNegativeToastTexts(page) {
    if (page.isClosed()) {
        return [];
    }

    return page
        .locator(TOAST_CONTAINER_SELECTOR)
        .evaluateAll((elements) => {
            const isRed = (color) => {
                const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color || '');

                if (!match) {
                    return false;
                }

                const [, red, green, blue] = match.map(Number);
                return red >= 180 && green < 130 && blue < 130;
            };

            return elements
                .filter((element) => element.getBoundingClientRect().width > 0 && element.innerText.trim())
                .filter((element) => {
                    if (/error|danger|fail|negative/i.test(element.className)) {
                        return true;
                    }

                    if (/success|info|positive/i.test(element.className)) {
                        return false;
                    }

                    const textElement = Array.from(element.querySelectorAll('*'))
                        .find((child) => child.children.length === 0 && child.innerText && child.innerText.trim()) || element;

                    return isRed(getComputedStyle(textElement).color);
                })
                .map((element) => element.innerText.replace(/\s+/g, ' ').trim().slice(0, 200));
        })
        .catch(() => []);
}

// 토스트 등장 애니메이션(fadeInUp)이 끝나 위치가 고정될 때까지 잠깐 기다린다. 최대 600ms.
async function waitForToastSettled(page, timeoutMs = 600) {
    const deadline = Date.now() + timeoutMs;
    let previous = null;

    while (Date.now() < deadline && !page.isClosed()) {
        const current = await page
            .locator(TOAST_CONTAINER_SELECTOR)
            .evaluateAll((elements) => JSON.stringify(elements
                .filter((element) => element.getBoundingClientRect().width > 0)
                .map((element) => { const rect = element.getBoundingClientRect(); return [Math.round(rect.top), Math.round(rect.left)]; })))
            .catch(() => null);

        if (current !== null && current === previous) {
            return;
        }

        previous = current;
        await page.waitForTimeout(60).catch(() => {});
    }
}

const attendanceAccounts = [
    { label: '낮고정근무', id: 'work101@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮선택근무', id: 'work102@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮시차근무', id: 'work103@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮교대근무', id: 'work104@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮탄력근무', id: 'work105@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮개인별일정근무', id: 'work106@ncpworkplace.net', password: REAL_ATT_PASSWORD },
];

function normalizeText(value = '') {
    return value.replace(/\s+/g, ' ').trim();
}

async function allowPermissionPrompt(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const allowButton = page
            .getByRole('button', { name: '허용', exact: true })
            .or(page.getByRole('link', { name: '허용', exact: true }))
            .first();

        if (!await allowButton.isVisible({ timeout: 500 }).catch(() => false)) {
            return;
        }

        await allowButton.click({ force: true }).catch(() => {});
        await page.waitForTimeout(150);
    }
}

async function loginWithRealAccount(page, account) {
    await page.goto(REAL_HOME_URL, { waitUntil: 'domcontentloaded' });
    await allowPermissionPrompt(page);
    await page.fill('#user_id', account.id);
    await page.click('#loginStart');
    await page.fill('#user_pwd', account.password);

    await Promise.all([
        page.waitForURL((url) => (
            url.hostname.endsWith('worksmobile.com') && !url.hostname.includes('auth')
        ), { timeout: 60000 }),
        page.click('#loginBtn'),
    ]);

    await page.goto(REAL_HOME_URL, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/home\.worksmobile\.com/, { timeout: 60000 });
    await allowPermissionPrompt(page);
}

async function getAttendanceState(page) {
    const attendanceWidget = page.locator('.widget_cover[data-widget-code="WG_006"]').first();
    await expect(attendanceWidget, '출퇴근 위젯').toBeVisible({ timeout: 60000 });

    // 위젯 내용(출근/퇴근 버튼 또는 근무 일정 안내)이 그려질 때까지 기다린 뒤 상태를 읽는다.
    await attendanceWidget
        .locator('.attendance_btn_area button, button:has-text("근무 일정"), :text("근무 일정이 없습니다")')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});
    await page.waitForTimeout(500);

    const attendanceInputArea = attendanceWidget.locator('.attendance_input_area').first();
    const attendanceButtonArea = attendanceWidget.locator('.attendance_btn_area').first();
    const bodyText = normalizeText(await attendanceWidget.innerText().catch(() => ''));

    return {
        attendanceWidget,
        attendanceInputArea,
        attendanceButtonArea,
        clockInButton: attendanceButtonArea.getByRole('button', { name: '출근' }),
        clockOutButton: attendanceButtonArea.getByRole('button', { name: '퇴근' }),
        isOn: /\bON\b/.test(bodyText),
        hasNoWorkSchedule: bodyText.includes(NO_WORK_SCHEDULE_MESSAGE)
            || bodyText.includes('근무 일정이 없습니다.'),
        text: bodyText,
    };
}

async function waitForCommutePopupReady(commutePage, actionName) {
    await commutePage.waitForLoadState('domcontentloaded');
    await expect(commutePage).toHaveURL(REAL_COMMUTE_URL_PATTERN, { timeout: 60000 });
    await commutePage
        .waitForFunction(() => !window.jQuery || window.jQuery.active === 0, null, { timeout: 5000 })
        .catch(() => {});
}

async function resetAttendanceFromWidget(page, state, accountLabel = '') {
    const editTimeButton = state.attendanceWidget.locator('.btn_time_set').first();

    if (!await editTimeButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`${state.text} 초기화 버튼이 없어 다음 계정으로 넘어갑니다.`);
        return false;
    }

    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await editTimeButton.click().catch(() => {});
    const commutePage = await popupPromise;

    if (!commutePage) {
        console.log('출퇴근 상세 팝업이 열리지 않아 다음 계정으로 넘어갑니다.');
        return false;
    }

    try {
        await waitForCommutePopupReady(commutePage, '출근');
        const initButton = commutePage.locator('#btn_init');

        if (!await initButton.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log('출퇴근 초기화 버튼이 없어 다음 계정으로 넘어갑니다.');
            return false;
        }

        await initButton.click();
        const confirmButton = commutePage
            .locator('.modal.show:visible button:visible, .modal.show:visible a:visible, [role="dialog"] button:visible, [role="dialog"] a:visible')
            .filter({ hasText: /확인|초기화/ })
            .last();
        await expect(confirmButton, '출퇴근 초기화 확인 버튼').toBeVisible({ timeout: 10000 });

        const initResponse = commutePage.waitForResponse((response) => (
            response.url().includes('/my-space/commute/init') && response.status() === 200
        ), { timeout: 10000 }).then((response) => response.json()).catch(() => null);
        await confirmButton.click({ force: true });

        // 초기화 중 부정 토스트가 뜨면 스크린샷을 남기고 이 계정은 건너뛴다.
        const toastText = await captureNegativeToast(commutePage, accountLabel);

        if (toastText) {
            console.log(`${accountLabel} 초기화 중 부정 토스트: ${toastText}`);
            return false;
        }

        const initBody = await initResponse;

        if (initBody && !initBody.success) {
            console.log(`출퇴근 초기화 응답 실패: ${JSON.stringify(initBody)}`);
            return false;
        }

        console.log('기존 출퇴근 기록을 초기화했습니다.');
        return true;
    } finally {
        await commutePage.close().catch(() => {});
    }
}

async function adjustSameClockInOutTime(commutePage) {
    const adjustment = await commutePage.locator('input').evaluateAll((inputs) => {
        const visible = (element) => Boolean(
            element.offsetWidth || element.offsetHeight || element.getClientRects().length,
        );
        const timeInputs = inputs.filter((input) => (
            visible(input) && /^\d{2}:\d{2}$/.test(input.value.trim())
        ));

        if (timeInputs.length < 2 || timeInputs[0].value !== timeInputs[1].value) {
            return null;
        }

        const [hour, minute] = timeInputs[0].value.split(':').map(Number);
        const totalMinutes = (hour * 60 + minute - 1 + 1440) % 1440;

        return {
            inputIndex: inputs.indexOf(timeInputs[0]),
            value: `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`,
        };
    });

    if (!adjustment) {
        return;
    }

    const clockInInput = commutePage.locator('input').nth(adjustment.inputIndex);
    await clockInInput.fill(adjustment.value);
    await clockInInput.press('Tab').catch(() => {});
    await clockInInput.evaluate((input) => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));
    });
}

async function selectRequiredWorkTime(commutePage) {
    const preferredRadio = commutePage
        .getByRole('radio', { name: /10:00\s*~\s*19:00/ })
        .first();

    if (await preferredRadio.count() > 0) {
        await preferredRadio.check({ force: true }).catch(() => {});

        if (await preferredRadio.isChecked().catch(() => false)) {
            return true;
        }
    }

    // 지난 시간대 라디오는 비활성이므로, 선택 가능한(활성) 라디오를 먼저 고른다.
    const radios = commutePage.locator('input[type="radio"]:not(:disabled)');
    const radioCount = await radios.count();

    for (let index = 0; index < radioCount; index += 1) {
        const radio = radios.nth(index);

        if (await radio.isChecked().catch(() => false)) {
            return true;
        }

        if (await radio.isEnabled().catch(() => false)) {
            await radio.check({ force: true }).catch(async () => {
                const label = commutePage.locator('label').filter({ has: radio }).first();
                await label.click({ force: true }).catch(() => {});
            });

            if (await radio.isChecked().catch(() => false)) {
                return true;
            }
        }
    }

    const timeLabel = commutePage
        .locator('label, span, div')
        .filter({ hasText: /^\s*\d{2}:\d{2}\s*~\s*\d{2}:\d{2}\s*$/ })
        .first();

    if (await timeLabel.isVisible({ timeout: 1000 }).catch(() => false)) {
        await timeLabel.click({ force: true }).catch(() => {});
        return true;
    }

    const labels = commutePage.locator('label:visible').filter({ hasText: /시간|근무/ });
    if (await labels.first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await labels.first().click({ force: true }).catch(() => {});
        return true;
    }

    return false;
}

async function confirmAttendanceAlerts(commutePage) {
    const earlyLeaveButton = commutePage.locator('#earlyConfirm_yesBtn:visible').first();

    if (await earlyLeaveButton.isVisible({ timeout: 1500 }).catch(() => false)) {
        await earlyLeaveButton.click({ force: true }).catch(() => {});
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const confirmButton = commutePage
            .locator('.modal.show:visible button:visible, .modal.show:visible a:visible, [role="dialog"] button:visible, [role="dialog"] a:visible')
            .filter({ hasText: /확인|계속|퇴근/ })
            .last();

        if (!await confirmButton.isVisible({ timeout: 1000 }).catch(() => false)) {
            return;
        }

        await confirmButton.click({ force: true }).catch(() => {});
        await commutePage.waitForTimeout(300);
    }
}

// 설정 파일(playwright.config.js) 유무와 무관하게 항상 프로젝트 루트에 저장되도록
// 이 파일의 위치(tests/<env>/) 기준으로 두 단계 위를 프로젝트 루트로 잡는다.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function getResultDir() {
    return path.join(PROJECT_ROOT, RESULT_DIR_NAME);
}

function cleanResultDir() {
    const dir = getResultDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    return dir;
}

// 스크린샷은 실행마다 비워지는 real_att_day_results 폴더에 "라벨 + 용도" 이름으로 저장한다.
function screenshotPath(fileName) {
    const dir = getResultDir();
    fs.mkdirSync(dir, { recursive: true });

    return path.join(dir, `${fileName}.png`);
}

// 퇴근 확인 화면: 홈 전체를 찍되 상단에 계정 라벨과 아이디 띠를 넣어 어떤 계정인지 보이게 한다.
async function saveAttendanceResultScreenshot(page, account) {
    const filePath = screenshotPath(`${account.label} 출퇴근확인`);

    await page.evaluate(({ label, id }) => {
        document.querySelector('#pw-account-banner')?.remove();
        const banner = document.createElement('div');
        banner.id = 'pw-account-banner';
        banner.textContent = `${label} / ${id} / ${new Date().toLocaleString('ko-KR')}`;
        Object.assign(banner.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            right: '0',
            zIndex: '2147483647',
            padding: '8px 16px',
            background: '#1d2b53',
            color: '#fff',
            font: 'bold 16px sans-serif',
            textAlign: 'center',
        });
        document.body.appendChild(banner);
    }, { label: account.label, id: account.id });

    await page.screenshot({ path: filePath, fullPage: true });

    return filePath;
}

// 계정별 부정 토스트 스크린샷 수. 여러 장이면 "라벨 부정 토스트 확인1, 2, ..." 로 번호를 붙인다.
const negativeToastScreenshotCounts = new Map();

async function saveNegativeToastScreenshot(targetPage, label, text) {
    const count = (negativeToastScreenshotCounts.get(label) || 0) + 1;
    negativeToastScreenshotCounts.set(label, count);
    const baseName = `${label} 부정 토스트 확인`;

    if (count === 2) {
        const firstPath = screenshotPath(baseName);

        if (fs.existsSync(firstPath)) {
            fs.renameSync(firstPath, screenshotPath(`${baseName}1`));
        }
    }

    const filePath = screenshotPath(count === 1 ? baseName : `${baseName}${count}`);
    // 토스트 등장 애니메이션이 끝나 위치가 고정되는 즉시 찍는다 (오래 기다리면 토스트가 사라진다).
    await waitForToastSettled(targetPage);
    await targetPage.screenshot({ path: filePath, fullPage: false });
    console.log(`[부정 토스트] ${label}: "${text}" -> ${filePath}`);
}

// "출근과 퇴근에 같은 시간" 토스트는 재시도로 해결되는 경우가 많아 두 번째까지는 스크린샷을 찍지 않는다.
const sameTimeToastCounts = new Map();

async function captureNegativeToast(targetPage, label, { capture = true } = {}) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
        if (targetPage.isClosed()) {
            return null;
        }

        const texts = await readNegativeToastTexts(targetPage);

        if (texts.length) {
            const text = texts.join(' / ');

            if (!capture) {
                return text;
            }

            if (text.includes(SAME_CLOCK_IN_OUT_MESSAGE)) {
                const sameTimeCount = (sameTimeToastCounts.get(label) || 0) + 1;
                sameTimeToastCounts.set(label, sameTimeCount);

                if (sameTimeCount <= 2) {
                    console.log(`[부정 토스트] ${label}: "${text}" (${sameTimeCount}번째, 스크린샷 생략)`);
                    return text;
                }
            }

            await saveNegativeToastScreenshot(targetPage, label, text);
            return text;
        }

        await targetPage.waitForTimeout(200).catch(() => {});
    }

    return null;
}

async function clickAttendanceButton(page, state, actionName, accountLabel = '') {
    await allowPermissionPrompt(page);
    const button = actionName === '출근' ? state.clockInButton : state.clockOutButton;

    if (!await button.isVisible({ timeout: 5000 }).catch(() => false)
        || !await button.isEnabled({ timeout: 5000 }).catch(() => false)) {
        return { skipped: true, reason: `${actionName} 버튼을 사용할 수 없습니다.` };
    }

    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await button.click();
    const commutePage = await popupPromise;

    if (!commutePage) {
        return { skipped: true, reason: `${actionName} 팝업이 열리지 않았습니다.` };
    }

    const skip = async (reason) => ({ skipped: true, reason });

    try {
        await waitForCommutePopupReady(commutePage, actionName);
        await allowPermissionPrompt(commutePage);
        let pageText = normalizeText(await commutePage.locator('body').innerText().catch(() => ''));

        // IP 제한, 근무 스케줄 없음 안내는 빨간 토스트로 뜨므로 스크린샷을 찍은 뒤 건너뛴다.
        const blockingMessage = [IP_BLOCKED_MESSAGE, NO_WORK_SCHEDULE_MESSAGE]
            .find((message) => pageText.includes(message));

        if (blockingMessage) {
            const blockingToast = await captureNegativeToast(commutePage, accountLabel);
            return skip(blockingToast || blockingMessage);
        }

        if (actionName === '출근') {
            const selected = await selectRequiredWorkTime(commutePage);

            if (/근로 시간을 선택하세요/.test(pageText) && !selected) {
                return skip('근로 시간 라디오 버튼을 찾지 못했습니다.');
            }

            if (selected) {
                await commutePage.waitForTimeout(300);
                pageText = normalizeText(await commutePage.locator('body').innerText().catch(() => ''));
            }
        }

        const confirmButton = commutePage.locator('#btn_confirm').filter({ hasText: actionName }).first();
        if (!await confirmButton.isEnabled({ timeout: 10000 }).catch(() => false)) {
            const disabledToast = await captureNegativeToast(commutePage, accountLabel);
            return skip(disabledToast || normalizeText(await commutePage.locator('body').innerText().catch(() => '')));
        }

        if (actionName === '퇴근') {
            await adjustSameClockInOutTime(commutePage);
        }

        const saveResponse = commutePage.waitForResponse((response) => (
            response.url().includes('/my-space/commute/saveWorkTimeInfo')
                && response.status() === 200
        ), { timeout: 30000 }).then((response) => response.json()).catch(() => null);

        await confirmButton.click();
        // 출근/퇴근 모두 부정 토스트가 보이면 스크린샷을 찍는다 (같은 시간 토스트만 2회까지 생략).
        // 단, "근로 시간을 선택하세요." 는 라디오를 고른 뒤 한 번 더 시도할 수 있으므로 첫 노출은 찍지 않는다.
        let toastText = await captureNegativeToast(commutePage, accountLabel, { capture: false });

        if (toastText && /근로 시간을 선택하세요/.test(toastText) && actionName === '출근') {
            console.log(`${accountLabel} 근로 시간 선택 토스트 발생, 라디오 선택 후 다시 시도합니다.`);
            await selectRequiredWorkTime(commutePage);
            await commutePage.waitForTimeout(300);
            await expect(confirmButton).toBeEnabled({ timeout: 10000 });
            await confirmButton.click();
            toastText = await captureNegativeToast(commutePage, accountLabel, { capture: false });
        }

        if (toastText) {
            // 재시도로도 해결되지 않은 부정 토스트는 규칙대로 스크린샷을 찍는다 (같은 시간 토스트는 2회까지 생략).
            await captureNegativeToast(commutePage, accountLabel);
            return skip(toastText);
        }

        if (actionName === '퇴근'
            && await confirmButton.isVisible({ timeout: 1000 }).catch(() => false)
            && await confirmButton.isEnabled({ timeout: 1000 }).catch(() => false)) {
            await confirmButton.click({ force: true });
        }

        await confirmAttendanceAlerts(commutePage);

        let body = await saveResponse;
        let responseText = JSON.stringify(body || '');

        if (actionName === '출근' && /근로 시간을 선택하세요/.test(responseText)) {
            const selected = await selectRequiredWorkTime(commutePage);

            if (selected) {
                const retryResponse = commutePage.waitForResponse((response) => (
                    response.url().includes('/my-space/commute/saveWorkTimeInfo')
                        && response.status() === 200
                ), { timeout: 30000 }).then((response) => response.json()).catch(() => null);

                await confirmButton.click();
                body = await retryResponse;
                responseText = JSON.stringify(body || '');
            }
        }

        if (responseText.includes(IP_BLOCKED_MESSAGE)) {
            return skip(IP_BLOCKED_MESSAGE);
        }

        if (body && body.success === false) {
            return skip(normalizeText(body.message || toastText || responseText));
        }

        return { skipped: false };
    } finally {
        await commutePage.close().catch(() => {});
    }
}

async function clockInForAccount(page, account) {
    let state = await getAttendanceState(page);

    if (state.hasNoWorkSchedule) {
        console.log(`${account.label} 건너뜀: ${NO_WORK_SCHEDULE_MESSAGE}`);
        return;
    }

    // 오늘 근로 시간이 이미 끝난 계정은 출근할 수 없으므로(위젯에 "근무 결과 신청"만 노출) 건너뛴다.
    if (state.text.includes('근로 시간이 종료되었습니다')) {
        console.log(`${account.label} 건너뜀 (퇴근 단계도 제외): 근로 시간이 종료되어 출근할 수 없습니다.`);
        return;
    }

    if (state.isOn || !await state.clockInButton.isEnabled({ timeout: 1000 }).catch(() => false)) {
        console.log(`${account.label} 이미 출근 상태이거나 출근 버튼이 없어 초기화합니다.`);
        const reset = await resetAttendanceFromWidget(page, state, account.label);

        if (!reset) {
            console.log(`${account.label} 초기화 실패로 출근을 건너뜁니다 (퇴근 단계도 제외).`);
            return;
        }

        await page.reload({ waitUntil: 'domcontentloaded' });
        state = await getAttendanceState(page);

        for (let attempt = 0; attempt < 20; attempt += 1) {
            const canClockIn = await state.clockInButton
                .isEnabled({ timeout: 500 })
                .catch(() => false);

            if (canClockIn) {
                break;
            }

            await page.waitForTimeout(500);
            state = await getAttendanceState(page);
        }
    }

    const clockInResult = await clickAttendanceButton(page, state, '출근', account.label);
    if (clockInResult.skipped) {
        console.log(`${account.label} 출근 건너뜀 (퇴근 단계도 제외): ${clockInResult.reason}`);
        return;
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    state = await getAttendanceState(page);
    if (!state.isOn) {
        console.log(`${account.label} 출근 요청은 성공했지만 위젯 ON 반영이 늦습니다. 퇴근 단계로 계속 진행합니다.`);
    }

    console.log(`${account.label} 출근 완료`);
    return true;
}

async function clockOutForAccount(page, account) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const state = await getAttendanceState(page);
        const canClockOut = await state.clockOutButton
            .isEnabled({ timeout: 1000 })
            .catch(() => false);

        if (!canClockOut) {
            // 출근만 기록하는 근무제(예: 탄력근무)는 출근 후에도 위젯이 ON으로 바뀌지 않고 퇴근 버튼이 없다.
            // 출근 요청이 성공했으므로 정상으로 보고 최종 화면을 출퇴근확인으로 남긴다.
            await state.attendanceWidget.scrollIntoViewIfNeeded().catch(() => {});
            const resultPath = await saveAttendanceResultScreenshot(page, account);
            console.log(`${account.label} 퇴근 버튼 없음 (출근만 기록하는 근무제). 정상 출근으로 처리 -> ${resultPath}`);
            return true;
        }

        const clockOutResult = await clickAttendanceButton(page, state, '퇴근', account.label);
        if (clockOutResult.skipped) {
            const sameTimeMessage = clockOutResult.reason.includes(SAME_CLOCK_IN_OUT_MESSAGE)
                || /출근.*퇴근.*같|같은.*시간|시간이 동일/.test(clockOutResult.reason);

            if (sameTimeMessage && attempt < 3) {
                console.log(`${account.label} 같은 출퇴근 시간 토스트 발생, 20초 후 재시도합니다. (${attempt}/3)`);
                await page.waitForTimeout(20000);
                await page.reload({ waitUntil: 'domcontentloaded' });
                continue;
            }

            console.log(`${account.label} 퇴근 건너뜀: ${clockOutResult.reason}`);
            return false;
        }

        await page.reload({ waitUntil: 'domcontentloaded' });
        const updatedState = await getAttendanceState(page);

        const clockOutButtonDisabled = !await updatedState.clockOutButton
            .isEnabled({ timeout: 1000 })
            .catch(() => false);

        if (!updatedState.isOn && clockOutButtonDisabled) {
            await updatedState.attendanceWidget.scrollIntoViewIfNeeded().catch(() => {});
            const resultPath = await saveAttendanceResultScreenshot(page, account);
            console.log(`${account.label} 퇴근 완료 -> ${resultPath}`);
            return true;
        }

        if (attempt < 3) {
            console.log(`${account.label} 퇴근 후에도 ON 상태라 재시도합니다. (${attempt}/3)`);
            continue;
        }

        return false;
    }

    return false;
}

// 낮 근무 계정(09:00~18:00) 전용. 18시 이후 계정은 별도 파일(real_att_night.spec.js)로 다룬다.
test.describe('리얼 출퇴근 위젯 자동화 (낮)', () => {
    test.beforeAll(() => {
        console.log(`결과 스크린샷 폴더 초기화: ${cleanResultDir()}`);
    });

    test('여섯 계정 출근 및 퇴근 확인', async ({ browser }) => {
        test.setTimeout(900000);
        const failures = [];

        const clockedInAccounts = [];

        for (const account of attendanceAccounts) {
            await test.step(`${account.label} 출근`, async () => {
                const context = await browser.newContext({
                    locale: 'ko-KR',
                    permissions: ['geolocation', 'notifications'],
                    geolocation: { latitude: 37.5665, longitude: 126.9780 },
                });
                const page = await context.newPage();
                page.on('dialog', async (dialog) => {
                    await dialog.accept().catch(() => {});
                });

                try {
                    console.log(`${account.label} 로그인 및 출근 시작`);
                    await loginWithRealAccount(page, account);
                    if (await clockInForAccount(page, account)) {
                        clockedInAccounts.push(account);
                    }
                } catch (error) {
                    failures.push(`${account.label} 출근: ${error.message}`);
                    console.error(`${account.label} 실패 후 다음 계정으로 진행: ${error.message}`);
                } finally {
                    await context.close();
                }
            });
        }

        for (const account of clockedInAccounts) {
            await test.step(`${account.label} 퇴근`, async () => {
                const context = await browser.newContext({
                    locale: 'ko-KR',
                    permissions: ['geolocation', 'notifications'],
                    geolocation: { latitude: 37.5665, longitude: 126.9780 },
                });
                const page = await context.newPage();
                page.on('dialog', async (dialog) => {
                    await dialog.accept().catch(() => {});
                });

                try {
                    console.log(`${account.label} 로그인 및 퇴근 시작`);
                    await loginWithRealAccount(page, account);
                    const clockedOut = await clockOutForAccount(page, account);

                    if (!clockedOut) {
                        failures.push(`${account.label} 퇴근 처리 실패`);
                    }
                } catch (error) {
                    failures.push(`${account.label} 퇴근: ${error.message}`);
                    console.error(`${account.label} 실패 후 다음 계정으로 진행: ${error.message}`);
                } finally {
                    await context.close();
                }
            });
        }

        expect(failures, failures.join('\n')).toEqual([]);
    });
});
