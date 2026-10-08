import { test, expect } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

// 계정 비밀번호는 코드에 두지 않고 .env 의 REAL_ATT_PASSWORD 로 읽는다 (여섯 계정 공통).
const REAL_ATT_PASSWORD = process.env.REAL_ATT_PASSWORD;

if (!REAL_ATT_PASSWORD) {
    throw new Error('.env 에 REAL_ATT_PASSWORD 값이 필요합니다. (.env.example 참고)');
}

// real_att_day.spec.js 계정(work101~106, 낮 근무) 6개의 출퇴근 기록만 초기화한다.
const REAL_HOME_URL = 'https://home.worksmobile.com/';
const REAL_COMMUTE_URL_PATTERN = /workplace\.worksmobile\.com\/my-space\/commute\/commuteDetail/;

const attendanceAccounts = [
    { label: '낮고정근무', id: 'work101@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮선택근무', id: 'work102@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮시차근무', id: 'work103@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮교대근무', id: 'work104@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮탄력근무', id: 'work105@ncpworkplace.net', password: REAL_ATT_PASSWORD },
    { label: '낮개인별일정근무', id: 'work106@ncpworkplace.net', password: REAL_ATT_PASSWORD },
];

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

async function waitForCommutePopupReady(commutePage) {
    await commutePage.waitForLoadState('domcontentloaded');
    await expect(commutePage).toHaveURL(REAL_COMMUTE_URL_PATTERN, { timeout: 60000 });
    await commutePage
        .waitForFunction(() => !window.jQuery || window.jQuery.active === 0, null, { timeout: 5000 })
        .catch(() => {});
}

async function getAttendanceState(page, account) {
    const attendanceWidget = page.locator('.widget_cover[data-widget-code="WG_006"]').first();
    await expect(attendanceWidget, `${account.label} 출퇴근 위젯`).toBeVisible({ timeout: 60000 });

    // 위젯 내용(출근/퇴근 버튼 또는 안내 문구)이 그려질 때까지 기다린 뒤 상태를 읽는다.
    await attendanceWidget
        .locator('.attendance_btn_area button, button:has-text("근무 일정"), :text("근무 일정이 없습니다"), :text("근로 시간이 종료")')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => {});
    await page.waitForTimeout(500);

    const attendanceButtonArea = attendanceWidget.locator('.attendance_btn_area').first();
    const text = (await attendanceWidget.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();

    return {
        attendanceWidget,
        clockInButton: attendanceButtonArea.getByRole('button', { name: '출근' }),
        isOn: /\bON\b/.test(text),
        text,
    };
}

async function resetAttendanceFromWidget(page, account, state) {
    if (!state.isOn && await state.clockInButton.isEnabled({ timeout: 1000 }).catch(() => false)) {
        console.log(`${account.label} 이미 초기화된 상태이며 출근 버튼이 활성화되어 있습니다.`);
        return true;
    }

    // 출퇴근 기록 자체가 없는 상태(근무 일정 없음, 근로 시간 종료 등)는 초기화할 것이 없다.
    if (!state.isOn && /근무 일정이 없습니다|근로 시간이 종료되었습니다|근무 스케줄을 업로드하세요/.test(state.text)) {
        console.log(`${account.label} 초기화할 출퇴근 기록이 없습니다: ${state.text.slice(0, 80)}`);
        return true;
    }

    const editTimeButton = state.attendanceWidget.locator('.btn_time_set').first();

    if (!await editTimeButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        throw new Error(`${account.label} 초기화 버튼과 출근 버튼을 확인하지 못했습니다. 위젯: ${state.text.slice(0, 80)}`);
    }

    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await editTimeButton.click().catch(() => {});
    const commutePage = await popupPromise;

    if (!commutePage) {
        console.log(`${account.label} 출퇴근 상세 팝업이 없어 다음 계정으로 넘어갑니다.`);
        return true;
    }

    try {
        await waitForCommutePopupReady(commutePage);
        const initButton = commutePage.locator('#btn_init');

        if (!await initButton.isVisible({ timeout: 10000 }).catch(() => false)) {
            console.log(`${account.label} 초기화 버튼이 없어 다음 계정으로 넘어갑니다.`);
            return true;
        }

        await initButton.click({ force: true });

        const confirmButton = commutePage
            .locator('.modal.show:visible button:visible, .modal.show:visible a:visible, [role="dialog"] button:visible, [role="dialog"] a:visible')
            .filter({ hasText: /확인|초기화/ })
            .last();
        await expect(confirmButton, `${account.label} 출퇴근 초기화 확인 버튼`).toBeVisible({ timeout: 10000 });

        const initResponse = commutePage.waitForResponse((response) => (
            response.url().includes('/my-space/commute/init') && response.status() === 200
        ), { timeout: 10000 }).then((response) => response.json()).catch(() => null);

        await confirmButton.click({ force: true });
        const initBody = await initResponse;

        if (!initBody?.success) {
            throw new Error(`${account.label} 초기화 응답 실패: ${JSON.stringify(initBody)}`);
        }

        console.log(`${account.label} 출퇴근 초기화 완료`);
    } finally {
        await commutePage.close().catch(() => {});
    }

    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloaded = await getAttendanceState(page, account);
    expect(reloaded.isOn, `${account.label} 초기화 후 위젯 OFF`).toBe(false);

    if (await reloaded.clockInButton.isEnabled({ timeout: 5000 }).catch(() => false)) {
        console.log(`${account.label} 초기화 후 출근 버튼 활성화 확인`);
    } else {
        console.log(`${account.label} 초기화 완료 (출근 버튼은 근무 유형/일정에 따라 노출되지 않음): ${reloaded.text.slice(0, 80)}`);
    }

    return true;
}

test.describe('리얼 출퇴근 초기화 (낮)', () => {
    test('낮고정근무부터 낮개인별일정근무까지 출퇴근 초기화', async ({ browser }) => {
        test.setTimeout(900000);
        const failures = [];

        for (const account of attendanceAccounts) {
            await test.step(`${account.label} 출퇴근 초기화`, async () => {
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
                    console.log(`${account.label} 로그인 및 출퇴근 초기화 시작`);
                    await loginWithRealAccount(page, account);
                    const state = await getAttendanceState(page, account);
                    await resetAttendanceFromWidget(page, account, state);
                } catch (error) {
                    failures.push(`${account.label}: ${error.message}`);
                    console.error(`${account.label} 실패 후 다음 계정으로 진행: ${error.message}`);
                } finally {
                    await context.close();
                }
            });
        }

        expect(failures, failures.join('\n')).toEqual([]);
    });
});
