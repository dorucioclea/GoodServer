// @flow

import MockAdapter from 'axios-mock-adapter'
import { first, fromPairs, keys } from 'lodash'

import getZoomProvider from '../ZoomProvider'
import createMockingHelper from '../../../api/__tests__/__util__'
import { levelConfigs } from '../../../../../imports/logger/options'

const ZoomProvider = getZoomProvider()
let helper
let zoomServiceMock

const sessionToken = 'fake-session-id'
const enrollmentIdentifier = 'fake-enrollment-identifier'

const payload = {
  sessionId: sessionToken,
  faceScan: Buffer.alloc(32),
  auditTrailImage: 'data:image/png:FaKEimagE==',
  lowQualityAuditTrailImage: 'data:image/png:FaKEimagE=='
}

const createLoggerMock = () => fromPairs(['log', ...keys(levelConfigs.levels)].map(logFn => [logFn, jest.fn()]))

const testSuccessfullEnrollment = async (alreadyEnrolled = false) => {
  const onEnrollmentProcessing = jest.fn()
  const wrappedResponse = expect(ZoomProvider.enroll(enrollmentIdentifier, payload, onEnrollmentProcessing)).resolves

  await wrappedResponse.toHaveProperty('isVerified', true)
  await wrappedResponse.toHaveProperty('alreadyEnrolled', alreadyEnrolled)

  expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(1, { isLive: true, isNotMatch: false })
  expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(2, { isDuplicate: false })
  expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(3, { isEnrolled: true })
}

const testEnrollmentError = async errorMessage => {
  const onProcessingMock = jest.fn()
  const wrappedResponse = expect(ZoomProvider.enroll(enrollmentIdentifier, payload, onProcessingMock)).rejects

  await wrappedResponse.toThrow(errorMessage)
  return { onProcessingMock, wrappedResponse }
}

const testEnrollmentServiceError = async errorMessage => {
  const { onProcessingMock, wrappedResponse } = await testEnrollmentError(errorMessage)

  await wrappedResponse.not.toHaveProperty('response')
  expect(onProcessingMock).not.toHaveBeenCalled()
}

const testSuccessfullEnrollmentDispose = async (enrollmentIdentifier, withCustomServer = false, loggerMock = null) => {
  const _ = withCustomServer
  const mockFn = `mock${_ ? 'Success' : ''}RemoveEnrollment${_ ? '' : 'NotSupported'}`

  helper[mockFn](enrollmentIdentifier)
  await expect(ZoomProvider.dispose(enrollmentIdentifier, loggerMock)).resolves.toBeUndefined()
}

describe('ZoomProvider', () => {
  beforeAll(() => {
    zoomServiceMock = new MockAdapter(ZoomProvider.api.http)
    helper = createMockingHelper(zoomServiceMock)
  })

  afterEach(() => zoomServiceMock.reset())

  afterAll(() => {
    zoomServiceMock.restore()
    zoomServiceMock = null
    helper = null
  })

  test('issueToken() should return session token', async () => {
    helper.mockSuccessSessionToken(sessionToken)

    await expect(ZoomProvider.issueToken()).resolves.toEqual(sessionToken)
  })

  test('isValid() validates payload if facemap and images are present', () => {
    expect(ZoomProvider.isPayloadValid(payload)).toBeTruthy()
    expect(ZoomProvider.isPayloadValid({})).toBeFalsy()
  })

  test('enroll() returns successfull response if liveness passed, no duplicates found and enrollment was successfull', async () => {
    helper.mockEnrollmentNotFound(enrollmentIdentifier)
    helper.mockSuccessEnrollment(enrollmentIdentifier)
    helper.mockEmptyResultsFaceSearch(enrollmentIdentifier)
    helper.mock3dDatabaseEnrollmentSuccess(enrollmentIdentifier)

    // should return alreadyEnrolled = false
    await testSuccessfullEnrollment(false)
  })

  test('enroll() calls match 3d and skips indexing if already enrolled', async () => {
    helper.mockEnrollmentFound(enrollmentIdentifier)
    helper.mockSuccessUpdateEnrollment(enrollmentIdentifier)
    helper.mockEmptyResultsFaceSearch(enrollmentIdentifier)

    // should return alreadyEnrolled = true
    await testSuccessfullEnrollment(true)

    const { post: postHistory } = zoomServiceMock.history
    const postRequest = first(postHistory)

    // 1nd post should be POST /match-3d-3d (match & update facemap)
    expect(postRequest).not.toBeUndefined()
    expect(postRequest).toHaveProperty('data')
    expect(postRequest).toHaveProperty('url', '/match-3d-3d')
    expect(JSON.parse(postRequest.data)).toHaveProperty('externalDatabaseRefID', enrollmentIdentifier)

    // no indexing requests should be in the calls history
    postHistory.forEach(({ url }) => expect(url).not.toEqual('/3d-db/enroll'))
  })

  test('enroll() throws if liveness check fails', async () => {
    helper.mockEnrollmentNotFound(enrollmentIdentifier)
    helper.mockFailedEnrollment(enrollmentIdentifier)

    const onEnrollmentProcessing = jest.fn()
    const wrappedResponse = expect(ZoomProvider.enroll(enrollmentIdentifier, payload, onEnrollmentProcessing)).rejects

    await wrappedResponse.toThrow(helper.failedLivenessMessage)
    await wrappedResponse.toHaveProperty('response')
    await wrappedResponse.toHaveProperty('response.isLive', false)
    await wrappedResponse.toHaveProperty('response.isVerified', false)

    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(1, { isLive: false })
  })

  test('enroll() throws if already enrolled and facemap not match', async () => {
    helper.mockEnrollmentFound(enrollmentIdentifier)
    helper.mockFailedUpdateEnrollment(enrollmentIdentifier, true)

    const onEnrollmentProcessing = jest.fn()
    const wrappedResponse = expect(ZoomProvider.enroll(enrollmentIdentifier, payload, onEnrollmentProcessing)).rejects

    await wrappedResponse.toThrow(helper.failedMatchMessage)
    await wrappedResponse.toHaveProperty('response')
    await wrappedResponse.toHaveProperty('response.isNotMatch', true)
    await wrappedResponse.toHaveProperty('response.isVerified', false)

    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(1, { isNotMatch: true })
  })

  test('enroll() throws if duplicates found', async () => {
    helper.mockEnrollmentNotFound(enrollmentIdentifier)
    helper.mockSuccessEnrollment(enrollmentIdentifier)
    helper.mockDuplicateFound(enrollmentIdentifier)

    const onEnrollmentProcessing = jest.fn()
    const wrappedResponse = expect(ZoomProvider.enroll(enrollmentIdentifier, payload, onEnrollmentProcessing)).rejects

    await wrappedResponse.toThrow(helper.duplicateFoundMessage)
    await wrappedResponse.toHaveProperty('response')
    await wrappedResponse.toHaveProperty('response.isDuplicate', true)
    await wrappedResponse.toHaveProperty('response.isVerified', false)

    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(1, { isLive: true, isNotMatch: false })
    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(2, { isDuplicate: true })
  })

  test('enroll() throws if enroll to 3D Database fails', async () => {
    helper.mockEnrollmentNotFound(enrollmentIdentifier)
    helper.mockSuccessEnrollment(enrollmentIdentifier)
    helper.mockEmptyResultsFaceSearch(enrollmentIdentifier)
    helper.mock3dDatabaseEnrollmentFailed(enrollmentIdentifier)

    const onEnrollmentProcessing = jest.fn()
    const wrappedResponse = expect(ZoomProvider.enroll(enrollmentIdentifier, payload, onEnrollmentProcessing)).rejects

    await wrappedResponse.toThrow(helper.failedEnrollmentMessage)
    await wrappedResponse.toHaveProperty('response')
    await wrappedResponse.toHaveProperty('response.isEnrolled', false)
    await wrappedResponse.toHaveProperty('response.isVerified', false)

    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(1, { isLive: true, isNotMatch: false })
    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(2, { isDuplicate: false })
    expect(onEnrollmentProcessing).toHaveBeenNthCalledWith(3, { isEnrolled: false })
  })

  test('enroll() throws on any Zoom service error and terminates without returning any response or calling callback', async () => {
    const uri = helper.enrollmentUri(enrollmentIdentifier)
    const unexpectedError = 'Unexpected error during search'

    zoomServiceMock
      .onGet(uri)
      .replyOnce(500)
      .onGet(uri)
      .networkErrorOnce()

    await testEnrollmentServiceError(helper.serviceErrorMessage)
    await testEnrollmentServiceError('Network Error')

    zoomServiceMock.reset()

    helper.mockEnrollmentNotFound(enrollmentIdentifier)
    helper.mockSuccessEnrollment(enrollmentIdentifier)
    helper.mockFailedSearch(enrollmentIdentifier, unexpectedError)

    await testEnrollmentError(unexpectedError)
  })

  test('isEnrollmentIndexed() checks enrollment existence', async () => {
    helper.mockSuccessReadEnrollmentIndex(enrollmentIdentifier)
    await expect(ZoomProvider.isEnrollmentIndexed(enrollmentIdentifier)).resolves.toBe(true)
    zoomServiceMock.reset()

    helper.mockEnrollmentNotExistsDuringReadIndex(enrollmentIdentifier)
    await expect(ZoomProvider.isEnrollmentIndexed(enrollmentIdentifier)).resolves.toBe(false)
  })

  test("dispose() removes existing enrollment, doesn't throws for unexisting", async () => {
    helper.mockSuccessRemoveEnrollmentFromIndex(enrollmentIdentifier)
    await testSuccessfullEnrollmentDispose(enrollmentIdentifier)

    zoomServiceMock.reset()
    helper.mockEnrollmentNotExistsDuringRemoveFromIndex(enrollmentIdentifier)
    await testSuccessfullEnrollmentDispose(enrollmentIdentifier)
  })

  test("dispose() logs if ZoOm server doesn't support remove enrollment", async () => {
    const loggerMock = createLoggerMock()

    helper.mockSuccessRemoveEnrollmentFromIndex(enrollmentIdentifier)
    await testSuccessfullEnrollmentDispose(enrollmentIdentifier, false, loggerMock)

    expect(loggerMock.warn).toBeCalledWith("ZoOm server doesn't supports removing enrollments", {
      enrollmentIdentifier
    })
  })

  test('dispose() removes existing enrollment from the external DB on the custom server', async () => {
    const loggerMock = createLoggerMock()

    helper.mockSuccessRemoveEnrollmentFromIndex(enrollmentIdentifier)
    await testSuccessfullEnrollmentDispose(enrollmentIdentifier, true, loggerMock)

    const deleteRequest = first(zoomServiceMock.history.delete)

    expect(deleteRequest).not.toBeUndefined()
    expect(deleteRequest).toHaveProperty('url', helper.enrollmentUri(enrollmentIdentifier))
    expect(loggerMock.warn).not.toBeCalledWith("ZoOm server doesn't supports removing enrollments")
  })

  test('dispose() throws on Zoom service error', async () => {
    helper.mockServiceErrorDuringRemoveFromIndex(enrollmentIdentifier)

    await expect(ZoomProvider.dispose(enrollmentIdentifier)).rejects.toThrow(helper.serviceErrorMessage)
  })
})
