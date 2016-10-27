// Just holds the course resource object

// Isolate this module's creation by putting it in an anonymous function
(function() {

function combineDateTime(datetime) {
    var date = new Date(datetime.date);
    var time = new Date(datetime.time);
    date.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds());
    return date;
}

function getWeeksDelta(firstDate, secondDate) {
    firstDate = firstDate || moment();
    secondDate = secondDate || moment();
    // By default, moment#diff will return a number rounded towards zero (down for positive, up for negative).
    // we instead want to always Math.floor for both positive and negative numbers
    return Math.floor(moment(firstDate).diff(moment(secondDate), 'weeks', true));
}

function getNewDuplicateDate(originalDate, weekDelta) {
    originalDate = originalDate || moment();
    weekDelta = weekDelta || 0;
    return moment(originalDate).add(weekDelta, 'weeks')
}

var module = angular.module('ubc.ctlt.acj.course',
    [
        'angularMoment',
        'ngResource',
        'ngRoute',
        'ui.bootstrap',
        'ubc.ctlt.acj.comment',
        'ubc.ctlt.acj.common.form',
        'ubc.ctlt.acj.common.interceptor',
        'ubc.ctlt.acj.comparison',
        'ubc.ctlt.acj.assignment',
        'ubc.ctlt.acj.common.highlightjs',
        'ubc.ctlt.acj.common.pdf',
        'ubc.ctlt.acj.toaster'
    ]
);

/***** Providers *****/
module.factory('CourseResource',
    ["$q", "$routeParams", "$log", "$resource", "Interceptors",
    function($q, $routeParams, $log, $resource, Interceptors)
{
    var url = '/api/courses/:id';
    var ret = $resource('/api/courses/:id', {id: '@id'},
        {
            // would enable caching for GET but there's no automatic cache
            // invalidation, I don't want to deal with that manually
            'get': {url: url, cache: true},
            'save': {method: 'POST', url: url, interceptor: Interceptors.cache},
            'delete': {method: 'DELETE', url: url, interceptor: Interceptors.cache},
            'createDuplicate': {method: 'POST', url: '/api/courses/:id/duplicate'},
            'getCurrentUserStatus': {url: '/api/courses/:id/assignments/status'},
            'getInstructorsLabels': {url: '/api/courses/:id/users/instructors/labels'},
            'getStudents': {url: '/api/courses/:id/users/students'}
        }
    );
    ret.MODEL = "Course"; // add constant to identify the model
        // being used, this is for permissions checking
        // and should match the server side model name
    return ret;
}]);

/***** Controllers *****/
module.controller(
    'CourseAssignmentsController',
    ["$scope", "$log", "$routeParams", "CourseResource", "AssignmentResource", "Authorize",
             "AuthenticationService", "required_rounds", "Toaster",
    function($scope, $log, $routeParams, CourseResource, AssignmentResource, Authorize,
             AuthenticationService, required_rounds, Toaster)
    {
        // get course info
        var courseId = $scope.courseId = $routeParams['courseId'];
        $scope.answered = {};
        $scope.count = {};
        $scope.filters = [];
        Authorize.can(Authorize.CREATE, AssignmentResource.MODEL, courseId).then(function(result) {
            $scope.canCreateAssignments = result;
        });
        Authorize.can(Authorize.EDIT, CourseResource.MODEL, courseId).then(function(result) {
            $scope.canEditCourse = result;
        });
        Authorize.can(Authorize.MANAGE, AssignmentResource.MODEL, courseId).then(function(result) {
            $scope.canManageAssignment = result;
            $scope.filters.push('All course assignments');
            if ($scope.canManageAssignment) {
                $scope.filters.push('Assignments being answered', 'Assignments being compared', 'Upcoming assignments');
            } else {
                $scope.filters.push('My pending assignments');
            }
            $scope.filter = $scope.filters[0];
        });
        CourseResource.get({'id': courseId}).$promise.then(
            function (ret) {
                $scope.course = ret;
            },
            function (ret) {
                Toaster.reqerror("Course Not Found For ID "+ courseId, ret);
            }
        );

        // get course assignments
        AssignmentResource.get({'courseId': courseId}).$promise.then(
            function (ret)
            {
                $scope.assignments = ret.objects;

                CourseResource.getCurrentUserStatus({'id': courseId}).$promise.then(
                    function (ret) {
                        var statuses = ret.statuses;
                        for (var key in $scope.assignments) {
                            assignment = $scope.assignments[key];
                            assignment.status = statuses[assignment.id]

                            // comparison count
                            assignment.comparisons_left = assignment.status.comparisons.left;
                            assignment.self_evaluation_needed = assignment.enable_self_evaluation ?
                                !assignment.status.comparisons.self_evaluation_completed : false;
                            assignment.steps_left = assignment.comparisons_left + (assignment.self_evaluation_needed ? 1 : 0);

                            // if evaluation period is set answers can be seen after it ends
                            if (assignment.compare_end) {
                                assignment.answers_available = assignment.after_comparing;
                            // if an evaluation period is NOT set - answers can be seen after req met
                            } else {
                                assignment.answers_available = assignment.after_comparing &&
                                    assignment.comparisons_left < 1 && !assignment.self_evaluation_needed;
                            }
                        }
                    },
                    function (ret) {
                        Toaster.reqerror("Assignment Status Not Found", ret)
                    }
                );
            },
            function (ret)
            {
                Toaster.reqerror("Assignments Not Found For Course ID " +
                    courseId, ret);
            }
        );

        $scope.deleteAssignment = function(course_id, assignment_id) {
            AssignmentResource.delete({'courseId': course_id, 'assignmentId': assignment_id}).$promise.then(
                function (ret) {
                    Toaster.success("Successfully deleted assignment " + ret.id);
                    $scope.assignments = _.filter($scope.assignments, function(assignment) {
                        return assignment.id != assignment_id;
                    });
                },
                function (ret) {
                    Toaster.reqerror("Assignment deletion failed", ret);
                }
            );
        };

        $scope.assignmentFilter = function(filter) {
            return function(assignment) {
                switch(filter) {
                    // return all assignments
                    case "All course assignments":
                        return true;
                    // INSTRUCTOR: return all assignments in answer period
                    case "Assignments being answered":
                        return assignment.answer_period;
                    // INSTRUCTOR: return all assignments in comparison period
                    case "Assignments being compared":
                        return assignment.compare_period;
                    // INSTRUCTOR: return all assignments that are unavailable to students at the moment
                    case "Upcoming assignments":
                        return !assignment.available;
                    // STUDENTS: return all assignments that need to be answered or compared
                    case "My pending assignments":
                        return (assignment.answer_period && !$scope.answered[assignment.id]) ||
                            (assignment.compare_period && assignment.steps_left > 0);
                    default:
                        return false;
                }
            }
        }
    }
]);

module.controller(
    'CourseSelectModalController',
    ["$rootScope", "$scope", "$modalInstance", "AssignmentResource", "moment",
     "Session", "Authorize", "CourseResource", "Toaster", "UserResource", "LTI",
    function ($rootScope, $scope, $modalInstance, AssignmentResource, moment,
              Session, Authorize, CourseResource, Toaster, UserResource, LTI) {

        $scope.loggedInUserId = null;
        $scope.submitted = false;
        $scope.totalNumCourses = 0;
        $scope.courseFilters = {
            page: 1,
            perPage: 10
        };
        $scope.courses = [];

        $scope.showDuplicateForm = false;
        $scope.course = {
            year: new Date().getFullYear(),
            name: LTI.getCourseName()
        };
        $scope.format = 'dd-MMMM-yyyy';
        $scope.date = {
            'course_start': {'date': null, 'time': new Date().setHours(0, 0, 0, 0)},
            'course_end': {'date': null, 'time': new Date().setHours(23, 59, 0, 0)},
        };
        $scope.originalCourse = {};
        $scope.duplicateCourse = {};

        Session.getUser().then(function(user) {
            $scope.loggedInUserId = user.id;
            $scope.updateCourseList();
            $scope.$watchCollection('courseFilters', filterWatcher);
        });

        $scope.selectCourse = function(course) {
            $modalInstance.close(course.id);
        };

        $scope.adjustDuplicateAssignmentDates = function(skipConfirm) {
            if (!skipConfirm) {
                if(!confirm("All assignment answer and comparison dates you manually changed will be lost. Are you sure you?")) {
                    return;
                }
            }
            // startPoint is original course start_date if set
            // if not set, then it is the earliest assignment answer start date
            // duplicated assignment dates will moved around based on this date and the original assignments dates
            var startPoint = null;
            if ($scope.originalCourse.start_date) {
                startPoint = moment($scope.originalCourse.start_date).startOf('isoWeek');
            } else if($scope.originalAssignments.length > 0) {
                startPoint = moment($scope.originalAssignments[0].answer_start).startOf('isoWeek');
                angular.forEach($scope.originalAssignments, function(assignment) {
                    var answerStartPoint = moment(assignment.answer_start).startOf('isoWeek');
                    if (answerStartPoint < startPoint) {
                        startPoint = answerStartPoint;
                    }
                });
            }
            var weekDelta = getWeeksDelta($scope.duplicateCourse.date.course_start.date, startPoint);

            $scope.duplicateAssignments = [];
            angular.forEach($scope.originalAssignments, function(assignment) {
                var duplicate_assignment = {
                    id: assignment.id,
                    name: assignment.name,
                    date: {
                        astart: {date: null, time: new Date().setHours(0, 0, 0, 0)},
                        aend: {date: null, time: new Date().setHours(23, 59, 0, 0)},
                        cstart: {date: null, time: new Date().setHours(0, 0, 0, 0)},
                        cend: {date: null, time: new Date().setHours(23, 59, 0, 0)}
                    }
                }

                duplicate_assignment.date.astart.date = getNewDuplicateDate(assignment.answer_start, weekDelta).toDate();
                duplicate_assignment.date.astart.time = moment(assignment.answer_start).toDate();

                duplicate_assignment.date.aend.date = getNewDuplicateDate(assignment.answer_end, weekDelta).toDate();
                duplicate_assignment.date.aend.time = moment(assignment.answer_end).toDate();

                if (assignment.compare_start) {
                    duplicate_assignment.date.cstart.date = getNewDuplicateDate(assignment.compare_start, weekDelta).toDate();
                    duplicate_assignment.date.cstart.time = moment(assignment.compare_start).toDate();
                }

                if (assignment.compare_end) {
                    duplicate_assignment.date.cend.date = getNewDuplicateDate(assignment.compare_end, weekDelta).toDate();
                    duplicate_assignment.date.cend.time = moment(assignment.compare_end).toDate();
                }

                if (assignment.compare_start && assignment.compare_end) {
                    duplicate_assignment.availableCheck = true;
                }

                duplicate_assignment.date.astart.open = function($event) {
                    $event.preventDefault();
                    $event.stopPropagation();
                    duplicate_assignment.date.astart.opened = true;
                };
                duplicate_assignment.date.aend.open = function($event) {
                    $event.preventDefault();
                    $event.stopPropagation();
                    duplicate_assignment.date.aend.opened = true;
                };
                duplicate_assignment.date.cstart.open = function($event) {
                    $event.preventDefault();
                    $event.stopPropagation();
                    duplicate_assignment.date.cstart.opened = true;
                };
                duplicate_assignment.date.cend.open = function($event) {
                    $event.preventDefault();
                    $event.stopPropagation();
                    duplicate_assignment.date.cend.opened = true;
                };

                $scope.duplicateAssignments.push(duplicate_assignment);
            });
        };

        $scope.selectDuplicateCourse = function(course) {
            $scope.showDuplicateForm = true;
            $scope.originalCourse = course;
            $scope.duplicateCourse = {
                year: new Date().getFullYear(),
                term: $scope.originalCourse.term,
                date: {
                    course_start: {date: null, time: new Date().setHours(0, 0, 0, 0)},
                    course_end: {date: null, time: new Date().setHours(23, 59, 0, 0)}
                }
            };

            if ($scope.originalCourse.start_date) {
                var weekDelta = getWeeksDelta(moment(), $scope.originalCourse.start_date);
                $scope.duplicateCourse.date.course_start.date = getNewDuplicateDate($scope.originalCourse.start_date, weekDelta).toDate();

                if ($scope.originalCourse.end_date) {
                    $scope.duplicateCourse.date.course_end.date = getNewDuplicateDate($scope.originalCourse.end_date, weekDelta).toDate();
                }
            }

            $scope.duplicateCourse.date.course_start.open = function($event) {
                $event.preventDefault();
                $event.stopPropagation();
                $scope.duplicateCourse.date.course_start.opened = true;
            };
            $scope.duplicateCourse.date.course_end.open = function($event) {
                $event.preventDefault();
                $event.stopPropagation();
                $scope.duplicateCourse.date.course_end.opened = true;
            };

            $scope.originalAssignments = [];
            $scope.duplicateAssignments = [];
            AssignmentResource.get({'courseId': $scope.originalCourse.id}).$promise.then(
                function (ret) {
                    $scope.originalAssignments = ret.objects;
                    $scope.adjustDuplicateAssignmentDates(true);
                },
                function (ret) {
                    Toaster.reqerror("Unable to retrieve course assignments: " + course.id, ret);
                }
            );
        };

        $scope.cancelSelectDuplicateCourse = function() {
            $scope.showDuplicateForm = false;
        };

        $scope.duplicate = function() {
            $scope.submitted = true;
            $scope.duplicateCourse.assignments = [];

            if ($scope.duplicateCourse.date.course_start.date != null) {
                $scope.duplicateCourse.start_date = combineDateTime($scope.duplicateCourse.date.course_start);
            } else {
                $scope.duplicateCourse.start_date = null;
            }
            if ($scope.duplicateCourse.date.course_end.date != null) {
                $scope.duplicateCourse.end_date = combineDateTime($scope.duplicateCourse.date.course_end);
            } else {
                $scope.duplicateCourse.end_date = null;
            }
            if ($scope.duplicateCourse.start_date != null && $scope.duplicateCourse.end_date != null && $scope.duplicateCourse.start_date > $scope.duplicateCourse.end_date) {
                Toaster.error('Course Period Conflict', 'Course end date/time must be after course start date/time.');
                $scope.submitted = false;
                return;
            }

            for (var index = 0; index < $scope.duplicateAssignments.length; index++) {
                var assignment = $scope.duplicateAssignments[index];

                var assignment_submit = {
                    id: assignment.id,
                    answer_start: combineDateTime(assignment.date.astart),
                    answer_end: combineDateTime(assignment.date.aend),
                    compare_start: combineDateTime(assignment.date.cstart),
                    compare_end: combineDateTime(assignment.date.cend),
                }

                // answer end datetime has to be after answer start datetime
                if (assignment_submit.answer_start >= assignment_submit.answer_end) {
                    Toaster.error('Answer Period Error for '+assignment.name, 'Answer end time must be after answer start time.');
                    $scope.submitted = false;
                    return;
                } else if (assignment.availableCheck && assignment_submit.answer_start > assignment_submit.compare_start) {
                    Toaster.error("Time Period Error for "+assignment.name, 'Please double-check the answer and comparison period start and end times.');
                    $scope.submitted = false;
                    return;
                } else if (assignment.availableCheck && assignment_submit.compare_start >= assignment_submit.compare_end) {
                    Toaster.error("Time Period Error for "+assignment.name, 'comparison end time must be after comparison start time.');
                    $scope.submitted = false;
                    return;
                }

                // if option is not checked; make sure no compare dates are saved.
                if (!assignment.availableCheck) {
                    assignment_submit.compare_start = null;
                    assignment_submit.compare_end = null;
                }

                $scope.duplicateCourse.assignments.push(assignment_submit);
            }

            CourseResource.createDuplicate({id: $scope.originalCourse.id}, $scope.duplicateCourse, function (ret) {
                Toaster.success("Course Duplicated", 'The course was successfully duplicated');
                // refresh permissions
                Session.expirePermissions();
                $scope.selectCourse(ret);
            }).$promise.finally(function() {
                $scope.submitted = false;
            });
        };

        $scope.date.course_start.open = function($event) {
            $event.preventDefault();
            $event.stopPropagation();
            $scope.date.course_start.opened = true;
        };
        $scope.date.course_end.open = function($event) {
            $event.preventDefault();
            $event.stopPropagation();
            $scope.date.course_end.opened = true;
        };

        $scope.save = function() {
            $scope.submitted = true;
            if ($scope.date.course_start.date != null) {
                $scope.course.start_date = combineDateTime($scope.date.course_start);
            } else {
                $scope.course.start_date = null;
            }
            if ($scope.date.course_end.date != null) {
                $scope.course.end_date = combineDateTime($scope.date.course_end);
            } else {
                $scope.course.end_date = null;
            }
            if ($scope.course.start_date != null && $scope.course.end_date != null && $scope.course.start_date > $scope.course.end_date) {
                Toaster.error('Course Period Conflict', 'Course end date/time must be after course start date/time.');
                $scope.submitted = false;
                return;
            }

            CourseResource.save({}, $scope.course, function (ret) {
                Toaster.success("Course Created", 'The course was created successfully');
                // refresh permissions
                Session.expirePermissions();
                $scope.selectCourse(ret);
            }).$promise.finally(function() {
                $scope.submitted = false;
            });
        };

        $scope.updateCourseList = function() {
            UserResource.getUserCourses($scope.courseFilters).$promise.then(
                function(ret) {
                    $scope.courses = ret.objects;
                    $scope.totalNumCourses =  ret.total;
                },
                function (ret) {
                    Toaster.reqerror("Unable to retrieve your courses.", ret);
                }
            );
        };

        var filterWatcher = function(newValue, oldValue) {
            if (angular.equals(newValue, oldValue)) return;
            $scope.updateCourseList();
        };
    }
]);

module.controller(
    'CourseController',
    ['$scope', '$log', '$route', '$routeParams', '$location', 'Session', 'Authorize',
     'CourseResource', 'Toaster', 'EditorOptions',
    function($scope, $log, $route, $routeParams, $location, Session, Authorize,
            CourseResource, Toaster, EditorOptions) {
        var self = this;
        $scope.editorOptions = EditorOptions.basic;
        $scope.course = {};
        var messages = {
            new: {title: 'Course Created', msg: 'The course created successfully'},
            edit: {title: 'Course Successfully Updated', msg: 'Your course changes have been saved.'}
        };

        // unlike for assignments, course dates initially blank
        $scope.format = 'dd-MMMM-yyyy';
        $scope.date = {
            'course_start': {'date': null, 'time': new Date().setHours(0, 0, 0, 0)},
            'course_end': {'date': null, 'time': new Date().setHours(23, 59, 0, 0)},
        };

        self['new'] = function() {
            $scope.course.year = new Date().getFullYear();
        };

        self.edit = function() {
            $scope.courseId = $routeParams['courseId'];
            CourseResource.get({'id':$scope.courseId}).$promise.then(
                function (ret) {
                    // dates may be left blank
                    $scope.date.course_start.date = ret.start_date != null ? new Date(ret.start_date) : null;
                    $scope.date.course_end.date = ret.end_date != null ? new Date(ret.end_date) : null;
                    $scope.date.course_start.time = new Date(ret.start_date);
                    $scope.date.course_end.time = new Date(ret.end_date);
                    $scope.course = ret;
                }
            );
        };

        Session.getUser().then(function(user) {
            $scope.loggedInUserId = user.id;
        });

        $scope.date.course_start.open = function($event) {
            $event.preventDefault();
            $event.stopPropagation();

            $scope.date.course_start.opened = true;
        };
        $scope.date.course_end.open = function($event) {
            $event.preventDefault();
            $event.stopPropagation();

            $scope.date.course_end.opened = true;
        };

        $scope.save = function() {
            $scope.submitted = true;

            if ($scope.date.course_start.date != null) {
                $scope.course.start_date = combineDateTime($scope.date.course_start);
            } else {
                $scope.course.start_date = null;
            }

            if ($scope.date.course_end.date != null) {
                $scope.course.end_date = combineDateTime($scope.date.course_end);
            } else {
                $scope.course.end_date = null;
            }

            if ($scope.course.start_date != null && $scope.course.end_date != null && $scope.course.start_date > $scope.course.end_date) {
                Toaster.error('Course Period Conflict', 'Course end date/time must be after course start date/time.');
                $scope.submitted = false;
                return;
            }

            CourseResource.save({id: $scope.course.id}, $scope.course, function (ret) {
                Toaster.success(messages[$scope.method].title, messages[$scope.method].msg);
                // refresh permissions
                Session.expirePermissions();
                $location.path('/course/' + ret.id);
            }).$promise.finally(function() {
                $scope.submitted = false;
            });
        };

        //  Calling routeParam method
        if ($route.current !== undefined && $route.current.method !== undefined) {
            $scope.method = $route.current.method;
            if (self.hasOwnProperty($route.current.method)) {
                self[$scope.method]();
            }
        }
    }]
);

// End anonymous function
})();